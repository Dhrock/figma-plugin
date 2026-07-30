import { inflateRawSync } from 'node:zlib';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  PACKAGE_SCHEMA_VERSION,
  V1_LIMITS,
  applyLayerDatabase,
  applyPlainTextDocument,
  applyArtboardCoordinates,
  collectArtboardIssues,
  createLayerDatabase,
  createStoredZip,
  crc32,
  fingerprintDocument,
  extractImageMetadata,
  normalizeSvgPathToOrigin,
  parseCoordinateCsv,
  createPlainTextDocument,
  readZipCentralDirectory,
  sanitizeOutputStem,
  sha256Hex,
  stableStringify,
  validateDocumentLimits,
  type MigrationIssue,
  type PackageManifest,
  type XdAsset,
  type XdDocument,
  type XdLayerDatabase,
  type XdPlainTextDocument,
  type ZipDirectoryEntry,
  type ZipEntry,
} from '../packages/core/src';

interface Arguments {
  semantic: string;
  coordinates?: string;
  layers?: string;
  assets?: string;
  references?: string;
  sourceXd?: string;
  texts?: string;
  out?: string;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.length <= 2) {
    printHelp();
    return;
  }
  const args = parseArguments(process.argv.slice(2));
  const document = JSON.parse(await readFile(args.semantic, 'utf8')) as XdDocument;
  const outputPath = args.out ?? join(dirname(args.semantic), `${sanitizeOutputStem(document.documentName)}.xd2fig`);
  const actualFingerprint = await fingerprintDocument(document);
  if (document.sourceFingerprint.value !== actualFingerprint) {
    throw new Error(`SOURCE_MISMATCH: semantic fingerprint ${document.sourceFingerprint.value} != ${actualFingerprint}`);
  }
  const plainText = await loadPlainText(args.texts ?? join(dirname(args.semantic), 'texts.json'), document);
  applyPlainTextDocument(document, plainText);
  const canonicalFingerprint = await fingerprintDocument(document);
  document.sourceFingerprint = {
    ...document.sourceFingerprint,
    value: canonicalFingerprint,
    nodeCount: document.nodes.length,
    artboardCount: document.artboardGuids.length,
  };
  const coordinatesPath = args.coordinates ?? join(dirname(args.semantic), 'coordinates.csv');
  let coordinateBytes: Uint8Array;
  try { coordinateBytes = new Uint8Array(await readFile(coordinatesPath)); }
  catch { throw new Error(`COORDINATES_REQUIRED: ${coordinatesPath}`); }
  const coordinates = parseCoordinateCsv(new TextDecoder().decode(coordinateBytes));
  applyArtboardCoordinates(document, coordinates);
  const layerDatabase = await loadLayerDatabase(args.layers ?? join(dirname(args.semantic), 'layers.json'), document);
  applyLayerDatabase(document, layerDatabase);
  normalizeDocumentPaths(document);

  const sourceArchive = args.sourceXd ? await loadArchive(args.sourceXd) : null;
  const assetEntries = new Map<string, ZipEntry>();
  const packagedAssets: XdAsset[] = [];
  const missingAssetIssues: MigrationIssue[] = [];
  let assetBytes = 0;

  for (const asset of document.assets) {
    const bytes = await resolveAssetBytes(asset, args.assets, sourceArchive);
    if (!bytes) {
      missingAssetIssues.push({
        id: `asset-missing-${asset.assetId}`,
        scope: 'artboard',
        severity: 'blocker',
        code: 'ASSET_BYTES_MISSING',
        message: `画像原本を取得できません: ${asset.originalFileName ?? asset.assetId}`,
        artboardGuids: [...new Set(asset.usages.map((usage) => usage.artboardGuid))],
        nodeGuids: asset.usages.map((usage) => usage.nodeGuid),
        allowedActions: [],
      });
      continue;
    }
    const digest = await sha256Hex(bytes);
    if (asset.sha256 && asset.sha256 !== digest) throw new Error(`HASH_MISMATCH: ${asset.assetId}`);
    const extension = asset.mimeType === 'image/jpeg' ? 'jpg' : asset.mimeType.split('/')[1];
    const packagedPath = `assets/${digest}.${extension}`;
    if (!assetEntries.has(packagedPath)) {
      assetEntries.set(packagedPath, { name: packagedPath, bytes });
      assetBytes += bytes.length;
    }
    const extractedMetadata = extractImageMetadata(bytes, asset.mimeType);
    packagedAssets.push({
      ...asset,
      path: packagedPath,
      sha256: digest,
      iccProfile: asset.iccProfile ?? extractedMetadata.iccProfile,
      exif: asset.exif ?? extractedMetadata.exif,
    });
  }

  document.assets = packagedAssets;
  const referenceEntries = await packageReferences(document, args.references, missingAssetIssues);
  document.issues = deduplicateIssues([...collectArtboardIssues(document), ...missingAssetIssues]);
  const documentBytes = encodeJson(document);
  const fontsBytes = encodeJson(document.fonts);
  const assetIndexBytes = encodeJson(document.assets);
  const preflightBytes = encodeJson({ issues: document.issues });
  const plainTextBytes = encodeJson(plainText);
  const layerDatabaseBytes = encodeJson(createLayerDatabase(document));
  const payloadEntries: ZipEntry[] = [
    { name: 'document.json', bytes: documentBytes },
    { name: 'texts.json', bytes: plainTextBytes },
    { name: 'coordinates.csv', bytes: coordinateBytes },
    { name: 'layers.json', bytes: layerDatabaseBytes },
    { name: 'fonts.json', bytes: fontsBytes },
    { name: 'assets/index.json', bytes: assetIndexBytes },
    { name: 'preflight.json', bytes: preflightBytes },
    ...referenceEntries,
    ...assetEntries.values(),
  ];
  const uncompressedBytes = payloadEntries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  const sizeIssues = validateDocumentLimits(document, { archive: 0, uncompressed: uncompressedBytes, assets: assetBytes });
  if (sizeIssues.length) throw new Error(sizeIssues.map((issue) => `${issue.code}: ${issue.message}`).join('\n'));

  const files: PackageManifest['files'] = {};
  for (const entry of payloadEntries) files[entry.name] = { sha256: await sha256Hex(entry.bytes), size: entry.bytes.length };
  const manifest: PackageManifest = {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    generatorVersion: readPackageVersion(),
    createdAt: new Date().toISOString(),
    sourceFingerprint: document.sourceFingerprint,
    files,
    limits: V1_LIMITS,
  };
  const zipBytes = createStoredZip([{ name: 'manifest.json', bytes: encodeJson(manifest) }, ...payloadEntries]);
  if (zipBytes.length > V1_LIMITS.archiveBytes) throw new Error(`PACKAGE_TOO_LARGE: ${zipBytes.length} bytes`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, zipBytes);
  process.stdout.write(`${outputPath}\n${document.artboardGuids.length} artboards, ${document.nodes.length} nodes, ${document.issues.length} issues\n`);
}

async function loadLayerDatabase(path: string, document: XdDocument): Promise<XdLayerDatabase> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as XdLayerDatabase;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return createLayerDatabase(document);
    throw error;
  }
}

async function loadPlainText(path: string, document: XdDocument): Promise<XdPlainTextDocument> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as XdPlainTextDocument;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return createPlainTextDocument(document);
    throw error;
  }
}

async function packageReferences(document: XdDocument, referencesDirectory: string | undefined, issues: MigrationIssue[]): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  const packaged = [];
  for (const reference of document.references ?? []) {
    let bytes: Uint8Array | null = null;
    if (referencesDirectory) {
      try { bytes = new Uint8Array(await readFile(resolve(referencesDirectory, basename(reference.path)))); } catch { /* Report below. */ }
    }
    if (!bytes) {
      issues.push({
        id: `reference-missing-${reference.artboardGuid}`,
        scope: 'artboard', severity: 'warning', code: 'VISUAL_REFERENCE_MISSING',
        message: 'XD基準PNGが無いため視覚差分を自動計算できません。',
        artboardGuids: [reference.artboardGuid], nodeGuids: [], allowedActions: [],
      });
      continue;
    }
    const sha256 = await sha256Hex(bytes);
    const path = `references/${reference.artboardGuid}.png`;
    entries.push({ name: path, bytes });
    packaged.push({ ...reference, path, sha256 });
  }
  document.references = packaged;
  return entries;
}

function normalizeDocumentPaths(document: XdDocument): void {
  for (const node of document.nodes) {
    if (!node.pathData) continue;
    node.sourcePathData ??= node.pathData;
    const result = normalizeSvgPathToOrigin(node.pathData, node.windingRule ?? 'NONZERO', { maxDeviationPx: 0.01 });
    node.pathData = result.originPathData;
    node.pathOffsetX = result.bounds.x;
    node.pathOffsetY = result.bounds.y;
    node.windingRule = result.windingRule;
  }
}

async function resolveAssetBytes(asset: XdAsset, assetsDirectory: string | undefined, archive: LoadedArchive | null): Promise<Uint8Array | null> {
  if (assetsDirectory) {
    const candidates = [asset.path, asset.originalFileName].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      const filePath = resolve(assetsDirectory, basename(candidate));
      try {
        const info = await stat(filePath);
        if (info.isFile()) return new Uint8Array(await readFile(filePath));
      } catch {
        // Continue to the source archive adapter.
      }
    }
  }
  if (archive) {
    const exact = archive.entries.filter((entry) => entry.name === asset.path);
    const candidates = exact.length ? exact : archive.entries.filter((entry) => basename(entry.name) === basename(asset.path));
    if (candidates.length > 1) throw new Error(`SOURCE_MISMATCH: asset path is ambiguous: ${asset.path}`);
    if (candidates[0]) return extractArchiveEntry(archive.bytes, candidates[0]);
  }
  return null;
}

interface LoadedArchive { bytes: Uint8Array; entries: ZipDirectoryEntry[] }

async function loadArchive(filePath: string): Promise<LoadedArchive> {
  const bytes = new Uint8Array(await readFile(filePath));
  return { bytes, entries: readZipCentralDirectory(bytes) };
}

function extractArchiveEntry(archive: Uint8Array, entry: ZipDirectoryEntry): Uint8Array {
  const compressed = archive.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  const bytes = entry.compression === 0 ? compressed : entry.compression === 8 ? new Uint8Array(inflateRawSync(compressed)) : null;
  if (!bytes) throw new Error(`Unsupported ZIP compression ${entry.compression}: ${entry.name}`);
  if (bytes.length !== entry.uncompressedSize || crc32(bytes) !== entry.crc) throw new Error(`HASH_MISMATCH: ${entry.name}`);
  return bytes;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${stableStringify(value)}\n`);
}

function deduplicateIssues(issues: MigrationIssue[]): MigrationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.nodeGuids.join(',')}:${issue.artboardGuids.join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseArguments(values: string[]): Arguments {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error(`Invalid argument near ${key ?? '(end)'}`);
    parsed[key.slice(2)] = value;
  }
  if (!parsed.semantic) throw new Error('--semantic is required.');
  return { semantic: resolve(parsed.semantic), coordinates: parsed.coordinates ? resolve(parsed.coordinates) : undefined, layers: parsed.layers ? resolve(parsed.layers) : undefined, assets: parsed.assets ? resolve(parsed.assets) : undefined, references: parsed.references ? resolve(parsed.references) : undefined, sourceXd: parsed['source-xd'] ? resolve(parsed['source-xd']) : undefined, texts: parsed.texts ? resolve(parsed.texts) : undefined, out: parsed.out ? resolve(parsed.out) : undefined };
}

function readPackageVersion(): string {
  return '0.1.0';
}

function printHelp(): void {
  process.stdout.write('Usage: npm run package -- --semantic semantic.json [--texts texts.json] [--coordinates coordinates.csv] [--layers layers.json] [--assets assets-dir] [--references references-dir] [--source-xd source.xd] [--out output.xd2fig]\nIf --out is omitted, the package is written beside semantic.json.\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
