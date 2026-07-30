import { inflateRawSync } from 'node:zlib';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  crc32,
  buildOutputFolderName,
  createLayerDatabase,
  createPlainTextDocument,
  deriveArtboardCoordinates,
  encodeCoordinateCsv,
  estimateXdTextFallbackGeometry,
  extractImageMetadata,
  formatDateStamp,
  fingerprintDocument,
  measureSvgPath,
  nextOutputTestNumber,
  readImageDimensions,
  readZipCentralDirectory,
  sha256Hex,
  xdPointTextAlignmentGeometry,
  xdPointTextBaselineGeometry,
  xdClipPathBounds,
  xdTextFrameLayoutBox,
  type FontAuditRecord,
  type MigrationIssue,
  type XdAsset,
  type XdColor,
  type XdDocument,
  type XdNode,
  type XdNodeType,
  type XdTextRange,
  type ZipDirectoryEntry,
} from '../packages/core/src';

interface Arguments { source: string; outDir?: string; outRoot?: string }
interface Archive { bytes: Uint8Array; entries: Map<string, ZipDirectoryEntry> }
type Raw = Record<string, any>;

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.length <= 2) {
    process.stdout.write('Usage: npm run direct-xd -- --source source.xd (--out-dir exact-output-dir | --out-root output-root)\n');
    return;
  }
  const args = parseArguments(process.argv.slice(2));
  const archive = await openArchive(args.source);
  const manifest = readJson(archive, 'manifest');
  if (manifest['manifest-format-version'] !== 6) throw new Error(`XD_FORMAT_UNSUPPORTED: manifest v${manifest['manifest-format-version']}`);
  const resources = readJson(archive, 'resources/graphics/graphicContent.agc');
  const sourceMap = buildSourceMap(resources.resources?.meta?.ux?.symbols ?? []);
  const documentName = cleanDocumentName(manifest.name, args.source);
  const outDir = args.outRoot
    ? await createNumberedOutputDirectory(args.outRoot, documentName)
    : await resolveOutputDirectory(args.outDir!, documentName);
  const nodes: XdNode[] = [];
  const artboardGuids: string[] = [];
  const fonts = new Map<string, FontAuditRecord>();
  const assets = new Map<string, XdAsset>();
  const issues: MigrationIssue[] = [];
  const usedGuids = new Set<string>();
  const assetsDirectory = join(outDir, 'assets');
  await mkdir(assetsDirectory, { recursive: true });

  const artwork = manifest.children?.find((child: Raw) => child.path === 'artwork');
  const artboards = (artwork?.children ?? []).filter((child: Raw) => String(child.path ?? '').startsWith('artboard-'));
  for (const entry of artboards) {
    const artboardGuid = String(entry.path).slice('artboard-'.length);
    const agcPath = `artwork/${entry.path}/graphics/graphicContent.agc`;
    if (!archive.entries.has(agcPath)) continue;
    const content = readJson(archive, agcPath);
    const rawArtboard = content.children?.find((child: Raw) => child.type === 'artboard');
    if (!rawArtboard) continue;
    const bounds = entry['uxdesign#bounds'] ?? resources.artboards?.[artboardGuid];
    if (!bounds) throw new Error(`SOURCE_MISMATCH: artboard bounds missing: ${artboardGuid}`);
    const context: ConvertContext = { archive, sourceMap, nodes, fonts, assets, issues, usedGuids, artboardGuid, artboardX: number(bounds.x), artboardY: number(bounds.y), componentFlattened: false, clippingApproximated: false };
    const childGuids: string[] = [];
    for (const child of rawArtboard.artboard?.children ?? []) childGuids.push(convertNode(child, artboardGuid, context, true, artboardGuid));
    const artboard: XdNode = {
      guid: artboardGuid,
      type: 'ARTBOARD',
      name: String(entry.name ?? artboardGuid),
      parentGuid: null,
      artboardGuid,
      children: childGuids,
      x: number(bounds.x), y: number(bounds.y), width: number(bounds.width), height: number(bounds.height),
      rotation: 0, visible: true, locked: false, opacity: 1,
      fill: colorFromFill(rawArtboard.style?.fill),
      clipContent: true,
      viewportHeight: optionalNumber(entry['uxdesign#viewport']?.height),
    };
    nodes.push(artboard);
    artboardGuids.push(artboardGuid);
    if (context.componentFlattened) issues.push(warning(artboardGuid, 'COMPONENTS_FLATTENED', 'AGC component参照を編集可能な通常レイヤーへ実体化しました。'));
    if (context.clippingApproximated) issues.push(warning(artboardGuid, 'CLIPPING_APPROXIMATED', 'XD clip pathをFigma FrameのclipsContentへ変換しました。'));
  }

  for (const asset of assets.values()) {
    const bytes = extract(archive, asset.path);
    await writeFile(join(assetsDirectory, asset.assetId), bytes);
  }
  issues.push({ id: 'xd-direct-adapter-v6', scope: 'package', severity: 'warning', code: 'XD_DIRECT_ADAPTER_USED', message: 'XD manifest v6 / AGCを直接解析しました。公開Scenegraph APIを利用できない環境向けの変換です。', artboardGuids: [], nodeGuids: [], allowedActions: [] });
  const fingerprint = await fingerprintDocument({ nodes, artboardGuids });
  const document: XdDocument = {
    documentName,
    sourceFingerprint: { algorithm: 'sha256', value: fingerprint, nodeCount: nodes.length, artboardCount: artboardGuids.length },
    coordinateSpace: 'XD_SCENEGRAPH_RAW_V1',
    nodes,
    artboardGuids,
    fonts: [...fonts.values()],
    assets: [...assets.values()],
    references: [],
    issues,
  };
  const layerDatabase = createLayerDatabase(document);
  document.layerDatabaseVersion = 1;
  await mkdir(outDir, { recursive: true });
  const semanticPath = join(outDir, 'semantic.json');
  await writeFile(semanticPath, JSON.stringify(document, null, 2));
  const plainText = createPlainTextDocument(document);
  await writeFile(join(outDir, 'texts.json'), JSON.stringify(plainText, null, 2));
  await writeFile(join(outDir, 'coordinates.csv'), encodeCoordinateCsv(deriveArtboardCoordinates(nodes)));
  await writeFile(join(outDir, 'layers.json'), JSON.stringify(layerDatabase, null, 2));
  await writeFile(join(outDir, 'export-complete.json'), JSON.stringify({
    completed: true,
    mode: 'xd-file-direct',
    source: basename(args.source),
    artboards: artboardGuids.length,
    nodes: nodes.length,
    texts: plainText.texts.length,
    assets: assets.size,
  }, null, 2));
  process.stdout.write(`${semanticPath}\n${artboardGuids.length} artboards, ${nodes.length} nodes, ${plainText.texts.length} texts, ${fonts.size} fonts, ${assets.size} assets\n`);
}

async function resolveOutputDirectory(requested: string, documentName: string): Promise<string> {
  if (basename(requested) !== 'output') return requested;
  await mkdir(requested, { recursive: true });
  const names = await readdir(requested);
  const dateStamp = formatDateStamp(new Date());
  const testNumber = nextOutputTestNumber(names, dateStamp, documentName);
  return join(requested, buildOutputFolderName(dateStamp, documentName, testNumber));
}

async function createNumberedOutputDirectory(root: string, documentName: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const names = await readdir(root);
  const dateStamp = formatDateStamp(new Date());
  const testNumber = nextOutputTestNumber(names, dateStamp, documentName);
  return join(root, buildOutputFolderName(dateStamp, documentName, testNumber));
}

interface ConvertContext {
  archive: Archive;
  sourceMap: Map<string, Raw>;
  nodes: XdNode[];
  fonts: Map<string, FontAuditRecord>;
  assets: Map<string, XdAsset>;
  issues: MigrationIssue[];
  usedGuids: Set<string>;
  artboardGuid: string;
  artboardX: number;
  artboardY: number;
  componentFlattened: boolean;
  clippingApproximated: boolean;
}

function convertNode(input: Raw, parentGuid: string, context: ConvertContext, artboardChild: boolean, prefix: string): string {
  const resolved = resolveNode(input, context.sourceMap);
  if (input.type === 'syncRef') context.componentFlattened = true;
  const seed = String(input.guid ?? input.id ?? resolved.id ?? `${prefix}-node`);
  const guid = uniqueGuid(seed, prefix, context.usedGuids);
  const transform = resolved.transform ?? resolved.meta?.ux?.localTransform ?? {};
  const shape = resolved.shape ?? {};
  const geometry = geometryOf(resolved);
  const clip = resolved.meta?.ux?.clipPathResources;
  const clipShape = clip?.children?.[0];
  const clipGeometry = clipShape ? geometryOf(clipShape) : null;
  const clipBounds = clipGeometry
    ? xdClipPathBounds(
      {
        x: clipGeometry.offsetX,
        y: clipGeometry.offsetY,
        width: clipGeometry.width,
        height: clipGeometry.height,
      },
      clipShape.transform,
    )
    : null;
  const localOriginX = clipBounds?.x ?? geometry.offsetX;
  const localOriginY = clipBounds?.y ?? geometry.offsetY;
  const baseX = number(transform.tx) + localOriginX - (artboardChild ? context.artboardX : 0);
  const baseY = number(transform.ty) + localOriginY - (artboardChild ? context.artboardY : 0);
  const childInputs: Raw[] = resolved.group?.children ?? [];
  const children = childInputs.map((child) => convertNode(child, guid, context, false, guid));
  if (clipBounds) {
    for (const childGuid of children) {
      const child = context.nodes.find((candidate) => candidate.guid === childGuid);
      if (!child) throw new Error(`CLIP_CHILD_MISSING: ${childGuid}`);
      child.x -= clipBounds.x;
      child.y -= clipBounds.y;
    }
  }
  let width = geometry.width;
  let height = geometry.height;
  if (children.length && (width <= 0 || height <= 0)) {
    const childNodes = children.map((childGuid) => context.nodes.find((node) => node.guid === childGuid)).filter((node): node is XdNode => Boolean(node));
    width = width > 0 ? width : Math.max(1, ...childNodes.map((node) => node.x + node.width), 1);
    height = height > 0 ? height : Math.max(1, ...childNodes.map((node) => node.y + node.height), 1);
  }
  if (clipBounds) {
    context.clippingApproximated = true;
    if (clipBounds.width > 0) width = clipBounds.width;
    if (clipBounds.height > 0) height = clipBounds.height;
  }
  const type = nodeType(resolved);
  const node: XdNode = {
    guid, type, name: String(resolved.name ?? type), parentGuid, artboardGuid: context.artboardGuid, children,
    x: baseX, y: baseY, width: Math.max(0.01, width), height: Math.max(0.01, height),
    rotation: Math.atan2(number(transform.b), number(transform.a, 1)) * 180 / Math.PI,
    visible: resolved.visible !== false, locked: resolved.locked === true,
    opacity: clamp(optionalNumber(resolved.style?.opacity) ?? 1, 0, 1),
    blendMode: typeof resolved.style?.blendMode === 'string' ? resolved.style.blendMode : undefined,
    isBackground: resolved.meta?.ux?.isBackground === true,
    maskGroup: resolved.meta?.ux?.mask === true,
    isMask: resolved.meta?.ux?.isMask === true,
    fill: colorFromFill(resolved.style?.fill),
    stroke: colorFromFill(resolved.style?.stroke),
    strokeWidth: optionalNumber(resolved.style?.stroke?.width),
    cornerRadius: optionalNumber(shape.r ?? shape.radius ?? shape.cornerRadius),
    polygonPointCount: shape.type === 'polygon' ? optionalNumber(shape.points) : undefined,
    clipContent: Boolean(clip),
    clipPathBounds: clipBounds ?? undefined,
    fixedWhenScrolling: resolved.meta?.ux?.fixed === true,
    pathData: shape.type === 'path' ? String(shape.path ?? '') : undefined,
    windingRule: shape.winding === 'evenodd' ? 'EVENODD' : 'NONZERO',
  };
  if (type === 'TEXT') node.text = textData(resolved, guid, context.fonts);
  const pattern = resolved.style?.fill?.type === 'pattern' ? resolved.style.fill.pattern : null;
  if (pattern?.meta?.ux?.uid) {
    const assetId = String(pattern.meta.ux.uid);
    const path = `resources/${assetId}`;
    if (context.archive.entries.has(path)) {
      node.assetId = assetId;
      const usage = { nodeGuid: guid, artboardGuid: context.artboardGuid, imageTransform: matrixFrom(pattern.transform) };
      const existing = context.assets.get(assetId);
      if (existing) existing.usages.push(usage);
      else {
        const bytes = extract(context.archive, path);
        const mimeType = sniffMime(bytes);
        const dimensions = readImageDimensions(bytes, mimeType);
        const metadata = extractImageMetadata(bytes, mimeType);
        context.assets.set(assetId, { assetId, path, sha256: '', mimeType, width: dimensions.width || number(pattern.width), height: dimensions.height || number(pattern.height), originalFileName: originalName(pattern.href), ...metadata, usages: [usage] });
      }
    } else {
      context.issues.push({ id: `asset-missing-${assetId}-${guid}`, scope: 'node', severity: 'blocker', code: 'ASSET_BYTES_MISSING', message: `AGC画像リソースがありません: ${assetId}`, artboardGuids: [context.artboardGuid], nodeGuids: [guid], allowedActions: [] });
    }
  }
  context.nodes.push(node);
  return guid;
}

function resolveNode(raw: Raw, sourceMap: Map<string, Raw>): Raw {
  if (raw.type !== 'syncRef') return raw;
  const source = sourceMap.get(String(raw.syncSourceGuid));
  if (!source) return { ...raw, type: raw.group?.children ? 'group' : 'group', name: raw.name ?? 'Unresolved Component' };
  return {
    ...source,
    ...raw,
    type: source.type,
    name: raw.name ?? source.name,
    transform: raw.transform ?? source.transform,
    style: { ...(source.style ?? {}), ...(raw.style ?? {}) },
    meta: { ...(source.meta ?? {}), ...(raw.meta ?? {}), ux: { ...(source.meta?.ux ?? {}), ...(raw.meta?.ux ?? {}) } },
    group: raw.group?.children ? raw.group : source.group,
    shape: raw.shape ?? source.shape,
    text: raw.text ?? source.text,
  };
}

function textData(raw: Raw, guid: string, fonts: Map<string, FontAuditRecord>): NonNullable<XdNode['text']> {
  const characters = extractPlainCharacters(raw);
  const sourceRanges: Raw[] = raw.meta?.ux?.rangedStyles?.length ? raw.meta.ux.rangedStyles : [{ ...raw.style?.font, fontFamily: raw.style?.font?.family, fontStyle: raw.style?.font?.style, fontSize: raw.style?.font?.size, charSpacing: raw.style?.textAttributes?.letterSpacing }];
  const styleRanges: XdTextRange[] = [];
  let remaining = characters.length;
  for (let index = 0; index < sourceRanges.length && remaining > 0; index += 1) {
    const range = sourceRanges[index];
    const family = String(range.fontFamily ?? range.family ?? raw.style?.font?.family ?? '');
    const style = String(range.fontStyle ?? range.style ?? raw.style?.font?.style ?? 'Regular');
    const length = index === sourceRanges.length - 1 ? remaining : Math.min(remaining, Math.max(0, number(range.length, remaining)));
    if (!length) continue;
    const key = `${family}\u0000${style}`;
    const audit: FontAuditRecord = fonts.get(key) ?? { family, style, postscriptName: range.postscriptName ?? raw.style?.font?.postscriptName ?? null, version: null, vendor: null, license: null, fsType: null, fileSha256: null, nodeGuids: [] };
    if (!audit.nodeGuids.includes(guid)) audit.nodeGuids.push(guid);
    fonts.set(key, audit);
    styleRanges.push({
      length, fontFamily: family, fontStyle: style, fontSize: number(range.fontSize ?? range.size ?? raw.style?.font?.size, 12),
      fill: colorFromPacked(range.fill?.value) ?? colorFromFill(raw.style?.fill),
      charSpacing: number(range.charSpacing ?? raw.style?.textAttributes?.letterSpacing),
      lineSpacing: optionalNumber(raw.style?.textAttributes?.lineHeight),
      underline: Boolean(range.underline), strikethrough: Boolean(range.strikethrough),
      textTransform: normalizeTextTransform(range.textTransform), textScript: normalizeTextScript(range.textScript),
    });
    remaining -= length;
  }
  if (!styleRanges.length) styleRanges.push({ length: characters.length, fontFamily: '', fontStyle: 'Regular', fontSize: 12, charSpacing: 0, underline: false, strikethrough: false, textTransform: 'none', textScript: 'none' });
  const frame = raw.text?.frame ?? {};
  const layoutBox = xdTextFrameLayoutBox(frame.type);
  const textAlign = textAlignment(raw);
  const alignmentGeometry = layoutBox === 'POINT'
    ? pointTextAlignmentGeometry(raw, textAlign)
    : { offsetX: 0 };
  const baselineGeometry = layoutBox === 'POINT'
    ? pointTextBaselineGeometry(raw)
    : { offsetY: 0 };
  return {
    characters,
    styleRanges,
    layoutBox,
    textAlign,
    width: optionalNumber(frame.width) ?? alignmentGeometry.width,
    height: optionalNumber(frame.height),
    positioningMode: 'TOP_LEFT',
    anchorOffsetX: alignmentGeometry.offsetX,
    anchorOffsetY: baselineGeometry.offsetY,
  };
}

function geometryOf(raw: Raw): { offsetX: number; offsetY: number; width: number; height: number } {
  const shape = raw.shape ?? {};
  if (raw.type === 'text') {
    const frame = raw.text?.frame ?? {};
    const layoutBox = xdTextFrameLayoutBox(frame.type);
    const alignmentGeometry = layoutBox === 'POINT'
      ? pointTextAlignmentGeometry(raw, textAlignment(raw))
      : { offsetX: 0 };
    const baselineGeometry = layoutBox === 'POINT'
      ? pointTextBaselineGeometry(raw)
      : { offsetY: 0 };
    const fontSize = number(raw.style?.font?.size, 12);
    const lineHeight = number(raw.style?.textAttributes?.lineHeight, fontSize * 1.2);
    const fallback = estimateXdTextFallbackGeometry(
      extractPlainCharacters(raw),
      fontSize,
      lineHeight,
      optionalNumber(frame.width) ?? alignmentGeometry.width,
      optionalNumber(frame.height),
    );
    return {
      offsetX: alignmentGeometry.offsetX,
      offsetY: baselineGeometry.offsetY,
      width: fallback.width,
      height: fallback.height,
    };
  }
  if (shape.type === 'rect') return { offsetX: number(shape.x), offsetY: number(shape.y), width: number(shape.width), height: number(shape.height) };
  if (shape.type === 'ellipse') return { offsetX: number(shape.cx) - number(shape.rx), offsetY: number(shape.cy) - number(shape.ry), width: number(shape.rx) * 2, height: number(shape.ry) * 2 };
  if (shape.type === 'circle') return { offsetX: number(shape.cx) - number(shape.r), offsetY: number(shape.cy) - number(shape.r), width: number(shape.r) * 2, height: number(shape.r) * 2 };
  if (shape.type === 'line') {
    const x1 = number(shape.x1), x2 = number(shape.x2), y1 = number(shape.y1), y2 = number(shape.y2);
    return { offsetX: Math.min(x1, x2), offsetY: Math.min(y1, y2), width: Math.max(0.01, Math.abs(x2 - x1)), height: Math.max(0.01, Math.abs(y2 - y1)) };
  }
  if (shape.type === 'path') {
    const bounds = measureSvgPath(String(shape.path ?? ''), { maxDeviationPx: 0.01 });
    return { offsetX: bounds.x, offsetY: bounds.y, width: Math.max(0.01, bounds.width), height: Math.max(0.01, bounds.height) };
  }
  const ux = raw.meta?.ux ?? {};
  return { offsetX: 0, offsetY: 0, width: number(ux.width), height: number(ux.height) };
}

function textAlignment(raw: Raw): NonNullable<XdNode['text']>['textAlign'] {
  const alignment = raw.style?.textAttributes?.paragraphAlign;
  return alignment === 'center' ? 'CENTER' : alignment === 'right' ? 'RIGHT' : 'LEFT';
}

function pointTextAlignmentGeometry(raw: Raw, textAlign: NonNullable<XdNode['text']>['textAlign']): { offsetX: number; width?: number } {
  if (raw.text?.frame?.type === 'area') return { offsetX: 0 };
  const lineStartXs: Array<number | null | undefined> = [];
  for (const paragraph of raw.text?.paragraphs ?? []) {
    for (const line of paragraph.lines ?? []) {
      for (const fragment of line ?? []) lineStartXs.push(fragment?.x);
    }
  }
  return xdPointTextAlignmentGeometry(textAlign, lineStartXs);
}

function pointTextBaselineGeometry(raw: Raw): { offsetY: number; firstLineHeight: number } {
  if (raw.text?.frame?.type === 'area') return { offsetY: 0, firstLineHeight: 0 };
  const fontSize = number(raw.style?.font?.size, 12);
  return xdPointTextBaselineGeometry(fontSize, optionalNumber(raw.style?.textAttributes?.lineHeight));
}

function nodeType(raw: Raw): XdNodeType {
  if (raw.type === 'text') return 'TEXT';
  if (raw.type === 'group') return 'GROUP';
  if (raw.type === 'shape') {
    if (raw.shape?.type === 'rect') return 'RECTANGLE';
    if (raw.shape?.type === 'ellipse' || raw.shape?.type === 'circle') return 'ELLIPSE';
    if (raw.shape?.type === 'line') return 'LINE';
    if (raw.shape?.type === 'polygon') return 'POLYGON';
    if (raw.shape?.type === 'path') return 'PATH';
  }
  return 'GROUP';
}

function buildSourceMap(symbols: Raw[]): Map<string, Raw> {
  const result = new Map<string, Raw>();
  const visit = (node: Raw): void => {
    if (node.id) result.set(String(node.id), node);
    for (const child of node.group?.children ?? []) visit(child);
  };
  for (const symbol of symbols) visit(symbol);
  return result;
}

async function openArchive(path: string): Promise<Archive> {
  const bytes = new Uint8Array(await readFile(path));
  return { bytes, entries: new Map(readZipCentralDirectory(bytes).map((entry) => [entry.name, entry])) };
}

function readJson(archive: Archive, path: string): Raw { return JSON.parse(new TextDecoder().decode(extract(archive, path))); }

function extract(archive: Archive, path: string): Uint8Array {
  const entry = archive.entries.get(path);
  if (!entry) throw new Error(`XD_ENTRY_MISSING: ${path}`);
  const compressed = archive.bytes.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  const bytes = entry.compression === 0 ? compressed : entry.compression === 8 ? new Uint8Array(inflateRawSync(compressed)) : null;
  if (!bytes || bytes.length !== entry.uncompressedSize || crc32(bytes) !== entry.crc) throw new Error(`HASH_MISMATCH: ${path}`);
  return bytes;
}

function sniffMime(bytes: Uint8Array): XdAsset['mimeType'] {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  throw new Error('ASSET_FORMAT_UNSUPPORTED');
}

function colorFromFill(fill: Raw | undefined): XdColor | undefined {
  if (!fill || fill.type !== 'solid') return undefined;
  const value = fill.color?.value;
  if (!value) return undefined;
  return { r: number(value.r), g: number(value.g), b: number(value.b), a: Math.round(clamp(optionalNumber(value.alpha) ?? optionalNumber(fill.color?.alpha) ?? 1, 0, 1) * 255) };
}

function colorFromPacked(value: unknown): XdColor | undefined {
  if (typeof value !== 'number') return undefined;
  const unsigned = value >>> 0;
  return { a: unsigned >>> 24 & 0xff, r: unsigned >>> 16 & 0xff, g: unsigned >>> 8 & 0xff, b: unsigned & 0xff };
}

function uniqueGuid(seed: string, prefix: string, used: Set<string>): string {
  let candidate = seed;
  let index = 1;
  while (used.has(candidate)) candidate = `${prefix}:${seed}:${index++}`;
  used.add(candidate);
  return candidate;
}

function warning(artboardGuid: string, code: string, message: string): MigrationIssue {
  return { id: `${code.toLowerCase()}-${artboardGuid}`, scope: 'artboard', severity: 'warning', code, message, artboardGuids: [artboardGuid], nodeGuids: [], allowedActions: [] };
}

function matrixFrom(value: Raw | undefined): number[][] | undefined {
  if (!value) return undefined;
  return [[number(value.a, 1), number(value.c), number(value.tx)], [number(value.b), number(value.d, 1), number(value.ty)]];
}

function originalName(href: unknown): string | null {
  if (typeof href !== 'string' || !href) return null;
  return basename(href);
}

function normalizeTextTransform(value: unknown): XdTextRange['textTransform'] { return value === 'uppercase' || value === 'lowercase' || value === 'titlecase' ? value : 'none'; }
function normalizeTextScript(value: unknown): XdTextRange['textScript'] { return value === 'superscript' || value === 'subscript' ? value : 'none'; }
function extractPlainCharacters(raw: Raw): string {
  if (typeof raw.text?.rawText === 'string') return raw.text.rawText;
  if (typeof raw.text?.text === 'string') return raw.text.text;
  return typeof raw.name === 'string' ? raw.name : '';
}
function cleanDocumentName(value: unknown, sourcePath: string): string {
  const cleaned = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned || basename(sourcePath).replace(/\.xd$/i, '');
}
function number(value: unknown, fallback = 0): number { const result = Number(value); return Number.isFinite(result) ? result : fallback; }
function optionalNumber(value: unknown): number | undefined { const result = Number(value); return value !== null && value !== undefined && Number.isFinite(result) ? result : undefined; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }

function parseArguments(values: string[]): Arguments {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index], value = values[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error(`Invalid argument near ${key ?? '(end)'}`);
    parsed[key.slice(2)] = value;
  }
  if (!parsed.source || Boolean(parsed['out-dir']) === Boolean(parsed['out-root'])) throw new Error('--source and exactly one of --out-dir / --out-root are required.');
  return { source: resolve(parsed.source), outDir: parsed['out-dir'] ? resolve(parsed['out-dir']) : undefined, outRoot: parsed['out-root'] ? resolve(parsed['out-root']) : undefined };
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
