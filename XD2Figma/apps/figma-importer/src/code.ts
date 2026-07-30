import {
  collectArtboardIssues,
  applyLayerDatabase,
  applyPlainTextDocument,
  layerRecordMap,
  normalizeCharactersForFigma,
  normalizePortableBlendMode,
  normalizeSvgPathToOrigin,
  resolveXdTextStyleRanges,
  sha256HexSync,
  validateManifest,
  type ApprovalRecord,
  type MigrationIssue,
  type PackageManifest,
  type VisualReviewRecord,
  type XdDocument,
  type XdLayerDatabase,
  type XdLayerRecord,
  type XdNode,
  type XdPlainTextDocument,
} from '../../../packages/core/src';
import {
  collectRequestedFonts,
  createFontResolutionCandidates,
  importFontKey,
  type FontResolutionReason,
  type ImportFontName,
} from './font-resolution';
import { IMPORT_PAGES } from './import-page-policy';
import { IMPORT_POLICY, aggregateBestEffortIssues, asBestEffortIssue, bestEffortWarning } from './import-policy';
import { pointTextPositionX, pointTextPositionY, pointTextSizingPlan } from './text-import-policy';

const NAMESPACE = 'xd2fig.migration.v1';
const STAGING_PREFIX = '__XD_IMPORT_STAGING__';
const TOOL_VERSION = '0.1.0';

type UiMessage =
  | { type: 'preflight'; manifest: PackageManifest; document: XdDocument; plainText?: XdPlainTextDocument; layerDatabase?: XdLayerDatabase; packageHash: string }
  | { type: 'cleanup-staging'; pageIds: string[] }
  | { type: 'start-import'; approvals: ApprovalRecord[] }
  | { type: 'asset-start'; assetId: string; sha256: string; sourceSha256: string; totalBytes: number; transform?: Record<string, unknown> }
  | { type: 'asset-chunk'; assetId: string; chunk: Uint8Array }
  | { type: 'asset-end'; assetId: string }
  | { type: 'finish-assets' }
  | { type: 'finalize-import'; visualReviews: VisualReviewSubmission[] }
  | { type: 'cancel' };

type VisualReviewSubmission = VisualReviewRecord & { heatmapBytes?: Uint8Array };

interface ImportState {
  manifest: PackageManifest;
  document: XdDocument;
  layerDatabase: XdLayerDatabase;
  layerRecords: Map<string, XdLayerRecord>;
  packageHash: string;
  issues: MigrationIssue[];
  approvals: ApprovalRecord[];
  excludedArtboards: Set<string>;
  originalPageId: string;
  stagingPages: PageNode[];
  imageHashes: Map<string, string>;
  importedAssets: Map<string, { sourceSha256: string; importedSha256: string; transform?: Record<string, unknown> }>;
  fontMappings: Map<string, FontName>;
  fontSubstitutions: FontSubstitutionRecord[];
  reportFontName: FontName | null;
  fallbacks: ImportFallbackRecord[];
  built?: { screens: PageNode; imported: string[]; failed: Array<{ guid: string; reason: string }> };
}

interface FontSubstitutionRecord {
  source: ImportFontName;
  resolved: ImportFontName | null;
  reason: FontResolutionReason | 'unavailable';
  nodeGuids: string[];
  artboardGuids: string[];
}

interface ImportFallbackRecord {
  code: string;
  sourceGuid: string;
  artboardGuid: string | null;
  sourceType: string;
  reason: string;
}

interface ReceivingAsset {
  sha256: string;
  sourceSha256: string;
  totalBytes: number;
  transform?: Record<string, unknown>;
  chunks: Uint8Array[];
  receivedBytes: number;
}

let pending: Omit<ImportState, 'approvals' | 'excludedArtboards' | 'originalPageId' | 'stagingPages' | 'imageHashes' | 'importedAssets' | 'fallbacks'> | null = null;
let state: ImportState | null = null;
const receivingAssets = new Map<string, ReceivingAsset>();
const pointTextBaselineCache = new Map<string, number>();

figma.showUI(__html__, { width: 440, height: 680, themeColors: true });
void detectInterruptedImport();

figma.ui.onmessage = async (message: UiMessage) => {
  try {
    if (message.type === 'cancel') {
      await rollbackAll();
      figma.closePlugin();
      return;
    }
    if (message.type === 'cleanup-staging') {
      await cleanupStaging(message.pageIds);
      return;
    }
    if (message.type === 'preflight') {
      await runPreflight(message.manifest, message.document, message.plainText, message.layerDatabase, message.packageHash);
      return;
    }
    if (message.type === 'start-import') {
      await startImport(message.approvals);
      return;
    }
    if (message.type === 'asset-start') {
      receivingAssets.set(message.assetId, { sha256: message.sha256, sourceSha256: message.sourceSha256, totalBytes: message.totalBytes, transform: message.transform, chunks: [], receivedBytes: 0 });
      figma.ui.postMessage({ type: 'asset-ack', assetId: message.assetId });
      return;
    }
    if (message.type === 'asset-chunk') {
      receiveAssetChunk(message.assetId, message.chunk);
      figma.ui.postMessage({ type: 'asset-ack', assetId: message.assetId });
      return;
    }
    if (message.type === 'asset-end') {
      await completeAsset(message.assetId);
      figma.ui.postMessage({ type: 'asset-complete', assetId: message.assetId });
      return;
    }
    if (message.type === 'finish-assets') {
      try { await buildDocument(); }
      catch (error) { await rollbackAll(); throw error; }
    }
    if (message.type === 'finalize-import') await finalizeImport(message.visualReviews);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    figma.ui.postMessage({ type: 'error', message: text });
    figma.notify(text, { error: true });
  }
};

async function detectInterruptedImport(): Promise<void> {
  await figma.loadAllPagesAsync();
  const pages = figma.root.children.filter((page) => page.name.startsWith(STAGING_PREFIX) && page.getSharedPluginData(NAMESPACE, 'staging') === 'true');
  if (pages.length) figma.ui.postMessage({ type: 'recovery-required', pages: pages.map((page) => ({ id: page.id, name: page.name })) });
}

async function cleanupStaging(pageIds: string[]): Promise<void> {
  await figma.loadAllPagesAsync();
  const currentPageId = figma.currentPage.id;
  const loaded = await Promise.all(pageIds.map((id) => figma.getNodeByIdAsync(id)));
  const pages = loaded.filter((node): node is PageNode => node?.type === 'PAGE');
  if (pages.some((page) => page.id === currentPageId)) {
    const safePage = figma.root.children.find((page) => !pageIds.includes(page.id));
    if (safePage) await figma.setCurrentPageAsync(safePage);
  }
  for (const page of pages) {
    if (page.getSharedPluginData(NAMESPACE, 'staging') === 'true') page.remove();
  }
  figma.ui.postMessage({ type: 'recovery-complete' });
}

async function runPreflight(
  manifest: PackageManifest,
  document: XdDocument,
  plainText: XdPlainTextDocument | undefined,
  layerDatabase: XdLayerDatabase | undefined,
  packageHash: string,
): Promise<void> {
  await figma.loadAllPagesAsync();
  const plainTextResult = plainText ? applyPlainTextDocument(document, plainText) : null;
  const issues = [
    ...validateManifest(manifest),
    ...aggregateBestEffortIssues(deduplicateIssues(collectArtboardIssues(document)).map(asBestEffortIssue)),
  ];
  if (document.coordinateSpace !== 'FIGMA_PARENT_LOCAL_FROM_ARTBOARD_V1') {
    issues.push(packageFatal('COORDINATE_SPACE_UNSUPPORTED', 'coordinates.csvで補正されたパッケージではありません。最新のPackage CLIで.xd2figを再生成してください。'));
  }
  if (!layerDatabase) {
    issues.push(packageFatal('LAYER_DATABASE_MISSING', 'layers.jsonが無いため親子相対座標を確定できません。最新のConverterで再生成してください。'));
  } else {
    try { applyLayerDatabase(document, layerDatabase); }
    catch (error) {
      issues.push(packageFatal('LAYER_DATABASE_INVALID', error instanceof Error ? error.message : String(error)));
    }
  }
  if (!plainTextResult) {
    issues.push(bestEffortWarning('PLAIN_TEXT_SOURCE_MISSING', 'texts.jsonが無い旧パッケージのため、document.json内の文字列を使用します。'));
  } else if (plainTextResult.changedCount > 0) {
    issues.push(bestEffortWarning(
      'PLAIN_TEXT_SOURCE_APPLIED',
      `独立抽出したtexts.jsonを正本として${plainTextResult.changedCount}件の文字列を置換しました。`,
    ));
  }
  if (figma.root.documentColorProfile !== 'SRGB') {
    issues.push(bestEffortWarning('COLOR_PROFILE_MISMATCH', 'FigmaファイルがsRGBではありません。現在のカラープロファイルのままインポートします。'));
  }
  const existing = figma.root.children.filter((page) => {
    const role = page.getSharedPluginData(NAMESPACE, 'role');
    return page.getSharedPluginData(NAMESPACE, 'sourceFingerprint') === manifest.sourceFingerprint.value && role === 'screens';
  });
  if (existing.length) issues.push(bestEffortWarning('IMPORT_ALREADY_EXISTS', '同一source fingerprintのインポート結果があります。既存ページを残したまま別ページへ再インポートします。'));

  const available = await figma.listAvailableFontsAsync();
  const availableNames = available.map((font) => font.fontName);
  const loadedFonts = new Set<string>();
  const fontMappings = new Map<string, FontName>();
  const fontSubstitutions: FontSubstitutionRecord[] = [];
  const nodeMap = new Map(document.nodes.map((node) => [node.guid, node]));
  const loadFirstCandidate = async (requested: ImportFontName): Promise<{ fontName: FontName; reason: FontResolutionReason } | null> => {
    for (const candidate of createFontResolutionCandidates(requested, availableNames)) {
      const key = importFontKey(candidate.fontName.family, candidate.fontName.style);
      try {
        if (!loadedFonts.has(key)) await figma.loadFontAsync(candidate.fontName);
        loadedFonts.add(key);
        return { fontName: candidate.fontName, reason: candidate.reason };
      } catch {
        // Continue to the next installed candidate. listAvailableFontsAsync may
        // still contain a face that the current editor cannot load.
      }
    }
    return null;
  };

  for (const requested of collectRequestedFonts(document)) {
    const artboards = [...new Set(requested.nodeGuids.map((guid) => nodeMap.get(guid)?.artboardGuid).filter((guid): guid is string => Boolean(guid)))];
    const resolution = await loadFirstCandidate(requested);
    if (resolution) fontMappings.set(importFontKey(requested.family, requested.style), resolution.fontName);
    if (!resolution || resolution.reason !== 'exact') {
      const record: FontSubstitutionRecord = {
        source: { family: requested.family, style: requested.style },
        resolved: resolution?.fontName ?? null,
        reason: resolution?.reason ?? 'unavailable',
        nodeGuids: requested.nodeGuids,
        artboardGuids: artboards,
      };
      fontSubstitutions.push(record);
      issues.push(bestEffortWarning(
        resolution?.reason === 'noto-sans' ? 'FONT_SUBSTITUTED_WITH_NOTO_SANS' : 'FONT_SUBSTITUTED_LAST_RESORT',
        resolution
          ? `${requested.family} ${requested.style} を ${resolution.fontName.family} ${resolution.fontName.style} で表示します。`
          : `${requested.family} ${requested.style} と代替フォントをロードできないため、テキストを保持用Frameへ変換します。`,
        requested.nodeGuids,
        artboards,
        { source: record.source, resolved: record.resolved, reason: record.reason },
      ));
    }
  }

  for (const font of document.fonts) {
    const artboards = [...new Set(font.nodeGuids.map((guid) => nodeMap.get(guid)?.artboardGuid).filter((guid): guid is string => Boolean(guid)))];
    const key = importFontKey(font.family, font.style);
    if (font.license && !/(open font license|apache|public domain)/i.test(font.license)) {
      issues.push({ id: `font-license-${key}`, scope: 'artboard', severity: 'warning', code: 'FONT_LICENSE_NOTICE', message: `${font.family} ${font.style} の利用許諾を確認してください。`, artboardGuids: artboards, nodeGuids: font.nodeGuids, allowedActions: [] });
    }
  }

  const reportFontName = (await loadFirstCandidate({ family: 'Noto Sans', style: 'Regular' }))?.fontName ?? null;
  const effectiveLayerDatabase = layerDatabase ?? { schemaVersion: 1, coordinateSpace: 'ARTBOARD_RELATIVE', records: [] };
  pending = {
    manifest,
    document,
    layerDatabase: effectiveLayerDatabase,
    layerRecords: layerRecordMap(effectiveLayerDatabase),
    packageHash,
    issues: deduplicateIssues(issues),
    fontMappings,
    fontSubstitutions,
    reportFontName,
  };
  figma.ui.postMessage({
    type: 'preflight-result',
    issues: pending.issues,
    stats: { artboards: document.artboardGuids.length, nodes: document.nodes.length, assets: document.assets.length, fontSubstitutions: fontSubstitutions.length },
    importPolicy: IMPORT_POLICY,
  });
}

async function startImport(approvals: ApprovalRecord[]): Promise<void> {
  if (!pending) throw new Error('先にpreflightを実行してください。');
  const current = pending;
  if (current.issues.some((issue) => issue.severity === 'fatal')) throw new Error('package fatalが残っているため開始できません。');
  const issueById = new Map(current.issues.map((issue) => [issue.id, issue]));
  const verifiedApprovals = approvals.map((record) => {
    const issue = issueById.get(record.issueId);
    if (!issue || issue.severity !== 'approvable' || !issue.allowedActions.includes(record.action)) throw new Error(`承認内容が不正です: ${record.issueId}`);
    if (record.packageHash !== current.packageHash) throw new Error(`承認のpackage hashが一致しません: ${record.issueId}`);
    const currentUserId = figma.currentUser?.id ?? undefined;
    return {
      ...record,
      approver: { id: currentUserId, name: figma.currentUser?.name ?? record.approver.name },
      toolVersion: TOOL_VERSION,
    };
  });
  const excluded = new Set<string>();
  state = {
    ...current,
    approvals: verifiedApprovals,
    excludedArtboards: excluded,
    originalPageId: figma.currentPage.id,
    stagingPages: [],
    imageHashes: new Map(),
    importedAssets: new Map(),
    fallbacks: [],
  };
  receivingAssets.clear();
  figma.ui.postMessage({ type: 'ready-for-assets', excludedArtboards: [...excluded] });
}

function receiveAssetChunk(assetId: string, rawChunk: Uint8Array): void {
  const receiver = receivingAssets.get(assetId);
  if (!receiver) throw new Error(`asset-startがありません: ${assetId}`);
  const chunk = new Uint8Array(rawChunk);
  receiver.chunks.push(chunk);
  receiver.receivedBytes += chunk.length;
  if (receiver.receivedBytes > receiver.totalBytes) throw new Error(`画像チャンクが宣言サイズを超えました: ${assetId}`);
}

async function completeAsset(assetId: string): Promise<void> {
  if (!state) throw new Error('インポートが開始されていません。');
  const receiver = receivingAssets.get(assetId);
  if (!receiver || receiver.receivedBytes !== receiver.totalBytes) throw new Error(`画像チャンクが不足しています: ${assetId}`);
  const bytes = joinChunks(receiver.chunks, receiver.totalBytes);
  if (sha256HexSync(bytes) !== receiver.sha256) throw new Error(`HASH_MISMATCH: ${assetId}`);
  const image = figma.createImage(bytes);
  const roundTrip = await image.getBytesAsync();
  if (sha256HexSync(roundTrip) !== receiver.sha256) throw new Error(`IMAGE_ROUNDTRIP_MISMATCH: ${assetId}`);
  state.imageHashes.set(assetId, image.hash);
  state.importedAssets.set(assetId, { sourceSha256: receiver.sourceSha256, importedSha256: receiver.sha256, transform: receiver.transform });
  receivingAssets.delete(assetId);
}

async function buildDocument(): Promise<void> {
  if (!state) throw new Error('インポートが開始されていません。');
  const suffix = new Date().toISOString().replace(/[:.]/g, '-');
  const [pageDefinition] = IMPORT_PAGES;
  const screens = createStagingPage(`${pageDefinition.name} ${suffix}`, pageDefinition.role);
  screens.setSharedPluginData(NAMESPACE, 'layerDatabaseVersion', String(state.layerDatabase.schemaVersion));
  screens.setSharedPluginData(NAMESPACE, 'layerRecordCount', String(state.layerDatabase.records.length));
  state.stagingPages.push(screens);
  const sourceNodes = new Map(state.document.nodes.map((node) => [node.guid, node]));
  const imported: string[] = [];
  const importedFrames: Array<{ guid: string; frame: FrameNode }> = [];
  const failed: Array<{ guid: string; reason: string }> = [];

  for (const artboardGuid of state.document.artboardGuids) {
    const source = sourceNodes.get(artboardGuid);
    if (!source) {
      try {
        const placeholder = figma.createFrame();
        screens.appendChild(placeholder);
        placeholder.name = `[XD missing artboard] ${artboardGuid}`;
        placeholder.resize(1, 1);
        placeholder.fills = [];
        placeholder.setSharedPluginData(NAMESPACE, 'sourceGuid', artboardGuid);
        placeholder.setSharedPluginData(NAMESPACE, 'fallbackCode', 'ARTBOARD_NOT_FOUND');
        recordFallback('ARTBOARD_NOT_FOUND', { guid: artboardGuid, artboardGuid, type: 'ARTBOARD' }, 'Source artboard metadata was not found.');
        imported.push(artboardGuid);
        importedFrames.push({ guid: artboardGuid, frame: placeholder });
      } catch (error) {
        failed.push({ guid: artboardGuid, reason: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }
    let frame: FrameNode | null = null;
    try {
      frame = figma.createFrame();
      screens.appendChild(frame);
      applyCommonBeforePosition(frame, source);
      commitNodePosition(frame, source, { x: 0, y: 0 });
      frame.clipsContent = source.clipContent ?? false;
      const mapping = new Map<string, SceneNode>([[source.guid, frame]]);
      for (const childGuid of figmaChildOrder(source, sourceNodes)) await createNodeTree(childGuid, frame, sourceNodes, mapping);
      applyFigmaChildRoles(source, sourceNodes, mapping);
      const expected = countSubtree(source, sourceNodes);
      if (mapping.size !== expected) recordFallback('STRUCTURE_COUNT_FALLBACK', source, `expected=${expected} actual=${mapping.size}`);
      validateBuiltSubtree(source, sourceNodes, mapping);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      recordFallback('ARTBOARD_PARTIAL_IMPORT', source, reason);
      if (!frame) {
        try {
          frame = figma.createFrame();
          screens.appendChild(frame);
          applyCommonBeforePosition(frame, source);
          commitNodePosition(frame, source, { x: 0, y: 0 });
          frame.fills = source.fill ? [solidPaint(source.fill)] : [];
        } catch (placeholderError) {
          failed.push({ guid: artboardGuid, reason: placeholderError instanceof Error ? placeholderError.message : String(placeholderError) });
          continue;
        }
      }
      frame.name = `[PARTIAL] ${source.name}`;
    }
    frame.setSharedPluginData(NAMESPACE, 'sourceGuid', source.guid);
    frame.setSharedPluginData(NAMESPACE, 'packageHash', state.packageHash);
    imported.push(artboardGuid);
    importedFrames.push({ guid: artboardGuid, frame });
  }

  await buildReport(screens, imported, failed);
  state.built = { screens, imported, failed };
  const referencesAvailable = Boolean(state.document.references?.length);
  if (referencesAvailable) {
    for (const item of importedFrames) {
      try {
        const bytes = await item.frame.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 }, colorProfile: 'DOCUMENT' });
        figma.ui.postMessage({ type: 'visual-candidate', artboardGuid: item.guid, bytes });
      } catch (error) {
        const source = sourceNodes.get(item.guid);
        if (source) recordFallback('VISUAL_EXPORT_UNAVAILABLE', source, error instanceof Error ? error.message : String(error));
        figma.ui.postMessage({ type: 'visual-candidate-unavailable', artboardGuid: item.guid, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  figma.ui.postMessage({ type: 'visual-review-required', imported, failed, excluded: [...state.excludedArtboards], referencesAvailable });
}

async function finalizeImport(visualReviews: VisualReviewSubmission[]): Promise<void> {
  if (!state?.built) throw new Error('視覚確認対象のインポートがありません。');
  const expected = new Set(state.built.imported);
  const byGuid = new Map(visualReviews.map((record) => [record.artboardGuid, record]));
  const verified: VisualReviewRecord[] = [];
  for (const guid of expected) {
    const submission = byGuid.get(guid);
    if (submission && submission.packageHash !== state.packageHash) throw new Error(`視覚確認のpackage hashが一致しません: ${guid}`);
    if (!submission) {
      verified.push({
        artboardGuid: guid,
        referenceSha256: null,
        figmaSha256: '',
        ssim: null,
        diffPixelRate: null,
        dimensionsMatch: null,
        approved: false,
        approver: { id: figma.currentUser?.id ?? undefined, name: figma.currentUser?.name ?? 'Figma current user' },
        approvedAt: new Date().toISOString(),
        packageHash: state.packageHash,
      });
      continue;
    }
    const { heatmapBytes: rawHeatmapBytes, ...record } = submission;
    const heatmapBytes = rawHeatmapBytes ? new Uint8Array(rawHeatmapBytes) : null;
    const heatmapSha256 = heatmapBytes ? sha256HexSync(heatmapBytes) : null;
    verified.push({
      ...record,
      heatmapSha256,
      approver: { id: figma.currentUser?.id ?? undefined, name: figma.currentUser?.name ?? record.approver.name },
    });
    if (heatmapBytes) await addHeatmapToReport(state.built.screens, guid, heatmapBytes, verified.length - 1);
  }
  setChunkedSharedPluginData(state.built.screens, 'visualReviews', JSON.stringify(verified));
  setChunkedSharedPluginData(state.built.screens, 'fallbacks', JSON.stringify(state.fallbacks));
  setChunkedSharedPluginData(state.built.screens, 'fontSubstitutions', JSON.stringify(state.fontSubstitutions));
  const reportText = state.built.screens.children.find((node): node is TextNode => node.type === 'TEXT' && node.name === 'XD2Figma Import Report');
  if (reportText) {
    reportText.characters += [
      '',
      'Visual review (human-approved):',
      ...verified.map((record) => `${record.artboardGuid}: SSIM=${record.ssim ?? 'n/a'}, diff=${record.diffPixelRate ?? 'n/a'}, dimensions=${record.dimensionsMatch ?? 'n/a'}`),
    ].join('\n');
  }
  for (const page of state.stagingPages) page.setSharedPluginData(NAMESPACE, 'staging', 'false');
  state.built.screens.name = IMPORT_PAGES[0].name;
  await figma.setCurrentPageAsync(state.built.screens);
  figma.viewport.scrollAndZoomIntoView(state.built.screens.children);
  figma.ui.postMessage({ type: 'import-complete', imported: state.built.imported, excluded: [...state.excludedArtboards], failed: state.built.failed });
  figma.notify(`${state.built.imported.length}件のアートボードをインポートしました。`);
  state = null;
  pending = null;
}

async function addHeatmapToReport(page: PageNode, artboardGuid: string, bytes: Uint8Array, index: number): Promise<void> {
  const image = figma.createImage(bytes);
  if (sha256HexSync(await image.getBytesAsync()) !== sha256HexSync(bytes)) throw new Error(`HEATMAP_ROUNDTRIP_MISMATCH: ${artboardGuid}`);
  const size = await image.getSizeAsync();
  const width = Math.min(480, size.width);
  const rectangle = figma.createRectangle();
  page.appendChild(rectangle);
  rectangle.name = `Difference heatmap — ${artboardGuid}`;
  rectangle.resize(Math.max(1, width), Math.max(1, size.height * width / Math.max(1, size.width)));
  rectangle.x = reportCoordinate(page, 'reportOriginX', 40);
  rectangle.y = reportCoordinate(page, 'reportOriginY', 40) + 220 + index * 440;
  rectangle.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FIT' }];
  rectangle.setSharedPluginData(NAMESPACE, 'artboardGuid', artboardGuid);
  rectangle.setSharedPluginData(NAMESPACE, 'heatmapSha256', sha256HexSync(bytes));
}

function createStagingPage(label: string, role: string): PageNode {
  if (!state) throw new Error('state missing');
  const page = figma.createPage();
  page.name = `${STAGING_PREFIX} ${label}`;
  page.setSharedPluginData(NAMESPACE, 'staging', 'true');
  page.setSharedPluginData(NAMESPACE, 'role', role);
  page.setSharedPluginData(NAMESPACE, 'sourceFingerprint', state.manifest.sourceFingerprint.value);
  page.setSharedPluginData(NAMESPACE, 'packageHash', state.packageHash);
  return page;
}

async function createNodeTree(guid: string, parent: BaseNode & ChildrenMixin, sourceNodes: Map<string, XdNode>, mapping: Map<string, SceneNode>): Promise<SceneNode> {
  const source = sourceNodes.get(guid);
  if (!source) {
    const placeholder = figma.createFrame();
    parent.appendChild(placeholder);
    placeholder.name = `[XD missing node] ${guid}`;
    placeholder.resize(1, 1);
    placeholder.fills = [];
    placeholder.setSharedPluginData(NAMESPACE, 'sourceGuid', guid);
    placeholder.setSharedPluginData(NAMESPACE, 'fallbackCode', 'NODE_NOT_FOUND');
    mapping.set(guid, placeholder);
    recordFallback('NODE_NOT_FOUND', { guid, artboardGuid: null, type: 'UNKNOWN' }, 'Source node metadata was not found.');
    return placeholder;
  }

  let fallbackCode = fallbackCodeForSource(source);
  let fallbackReason = fallbackCode ? `${source.type} is represented as a regular Figma Frame.` : '';
  let node: SceneNode;
  try {
    if (source.children.length && !sourceTypeSupportsChildren(source.type)) {
      node = figma.createFrame();
      fallbackCode = 'CHILDREN_CONTAINER_FALLBACK';
      fallbackReason = `${source.type} unexpectedly contains children, so a Frame preserves the subtree.`;
    } else {
      node = await createFigmaNode(source);
    }
  } catch (error) {
    node = figma.createFrame();
    fallbackCode = 'NODE_CREATION_FALLBACK';
    fallbackReason = error instanceof Error ? error.message : String(error);
  }
  parent.appendChild(node);
  try { applyCommonBeforePosition(node, source); }
  catch (error) {
    fallbackCode = fallbackCode ?? 'PROPERTY_APPLICATION_FALLBACK';
    fallbackReason = error instanceof Error ? error.message : String(error);
  }
  mapping.set(guid, node);
  if (fallbackCode) markFallbackNode(node, source, fallbackCode, fallbackReason);
  if ('children' in node) {
    for (const childGuid of figmaChildOrder(source, sourceNodes)) await createNodeTree(childGuid, node as BaseNode & ChildrenMixin, sourceNodes, mapping);
    applyFigmaChildRoles(source, sourceNodes, mapping);
  }
  const contentFitOffset = fitContainerToContents(node, source);
  commitNodePosition(node, source, contentFitOffset);
  return node;
}

async function createFigmaNode(source: XdNode): Promise<SceneNode> {
  switch (source.type) {
    case 'RECTANGLE': return figma.createRectangle();
    case 'ELLIPSE': return figma.createEllipse();
    case 'LINE': return figma.createLine();
    case 'POLYGON': {
      const polygon = figma.createPolygon();
      if (source.polygonPointCount !== undefined) polygon.pointCount = Math.max(3, Math.round(source.polygonPointCount));
      return polygon;
    }
    case 'PATH':
    case 'BOOLEAN_GROUP': {
      const vector = figma.createVector();
      if (!source.pathData) throw new Error(`PATH_DATA_MISSING: ${source.guid}`);
      const normalized = normalizeSvgPathToOrigin(source.pathData, source.windingRule ?? 'NONZERO', { maxDeviationPx: 0.01 });
      vector.vectorPaths = [{ data: normalized.originPathData, windingRule: normalized.windingRule }];
      vector.setSharedPluginData(NAMESPACE, 'pathOriginOffset', JSON.stringify({
        x: source.pathOffsetX ?? normalized.bounds.x,
        y: source.pathOffsetY ?? normalized.bounds.y,
      }));
      return vector;
    }
    case 'TEXT': return createTextNode(source);
    default: {
      const frame = figma.createFrame();
      frame.fills = [];
      frame.clipsContent = sourceIsMaskGroup(source) ? false : source.clipContent ?? source.type === 'SCROLLABLE_GROUP';
      if (source.type === 'SCROLLABLE_GROUP') frame.overflowDirection = 'BOTH';
      return frame;
    }
  }
}

async function createTextNode(source: XdNode): Promise<TextNode> {
  if (!source.text) throw new Error(`TEXT_DATA_MISSING: ${source.guid}`);
  const node = figma.createText();
  const first = source.text.styleRanges[0];
  if (!first) throw new Error(`TEXT_STYLE_MISSING: ${source.guid}`);
  const firstFont = resolvedFont(first.fontFamily, first.fontStyle);
  if (!firstFont) throw new Error(`FONT_FALLBACK_UNAVAILABLE: ${first.fontFamily} ${first.fontStyle}`);
  node.fontName = firstFont;
  const displayCharacters = normalizeCharactersForFigma(source.text.characters);
  node.characters = displayCharacters;
  setChunkedSharedPluginData(node, 'sourceCharacters', source.text.characters);
  if (source.text.positioningMode) node.setSharedPluginData(NAMESPACE, 'textPositioningMode', source.text.positioningMode);
  if (source.text.anchorOffsetX !== undefined) node.setSharedPluginData(NAMESPACE, 'sourceTextAnchorOffsetX', String(source.text.anchorOffsetX));
  if (source.text.anchorOffsetY !== undefined) node.setSharedPluginData(NAMESPACE, 'sourceTextAnchorOffsetY', String(source.text.anchorOffsetY));
  if (displayCharacters !== source.text.characters) {
    node.setSharedPluginData(NAMESPACE, 'charactersNormalization', 'CR_TO_LF_1_TO_1');
  }
  node.textAlignHorizontal = source.text.textAlign;
  for (const resolved of resolveXdTextStyleRanges(node.characters, source.text.styleRanges)) {
    const { start, end, range } = resolved;
    const rangeFont = resolvedFont(range.fontFamily, range.fontStyle) ?? firstFont;
    node.setRangeFontName(start, end, rangeFont);
    node.setRangeFontSize(start, end, Math.max(0.01, range.fontSize));
    node.setRangeLetterSpacing(start, end, { unit: 'PIXELS', value: range.charSpacing / 1000 * Math.max(0.01, range.fontSize) });
    node.setRangeLineHeight(start, end, range.lineSpacing && range.lineSpacing > 0 ? { unit: 'PIXELS', value: range.lineSpacing } : { unit: 'AUTO' });
    node.setRangeTextDecoration(start, end, range.underline ? 'UNDERLINE' : range.strikethrough ? 'STRIKETHROUGH' : 'NONE');
    node.setRangeTextCase(start, end, range.textTransform === 'uppercase' ? 'UPPER' : range.textTransform === 'lowercase' ? 'LOWER' : range.textTransform === 'titlecase' ? 'TITLE' : 'ORIGINAL');
    if (range.fill) node.setRangeFills(start, end, [solidPaint(range.fill)]);
  }
  setChunkedSharedPluginData(node, 'sourceFonts', JSON.stringify(source.text.styleRanges.map((range) => ({
    family: range.fontFamily,
    style: range.fontStyle,
    resolved: resolvedFont(range.fontFamily, range.fontStyle),
  }))));
  if (source.text.layoutBox === 'POINT') {
    const sizing = pointTextSizingPlan(source.text.width);
    node.textAutoResize = sizing.textAutoResize;
    if (typeof source.text.width === 'number' && Number.isFinite(source.text.width)) {
      node.setSharedPluginData(NAMESPACE, 'sourceTextWidth', String(source.text.width));
    }
    try {
      const baselineFromTop = measurePointTextBaselineFromTop(node, firstFont, first.fontSize, first.lineSpacing);
      node.setSharedPluginData(NAMESPACE, 'figmaBaselineFromTop', String(baselineFromTop));
    } catch (error) {
      recordFallback(
        'POINT_TEXT_BASELINE_MEASUREMENT_UNAVAILABLE',
        source,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  else if (source.text.layoutBox === 'AUTO_HEIGHT') {
    node.textAutoResize = 'HEIGHT';
    node.resize(Math.max(0.01, source.width), Math.max(0.01, node.height));
  } else {
    const width = Math.max(0.01, source.width);
    const sourceHeight = Math.max(0.01, source.height);
    node.textAutoResize = 'HEIGHT';
    node.resize(width, Math.max(0.01, node.height));
    const requiredHeight = node.height;
    node.textAutoResize = 'NONE';
    node.resize(width, sourceHeight);
    node.setSharedPluginData(NAMESPACE, 'sourceTextHeight', String(sourceHeight));
    if (requiredHeight > sourceHeight + 0.01) {
      node.setSharedPluginData(NAMESPACE, 'requiredTextHeight', String(requiredHeight));
      recordFallback('TEXT_BOX_CLAMPED_TO_XD_BOUNDS', source, `sourceHeight=${sourceHeight} requiredHeight=${requiredHeight}`);
    }
  }
  return node;
}

function applyCommonBeforePosition(node: SceneNode, source: XdNode): void {
  node.name = source.name;
  node.visible = source.visible;
  node.locked = source.locked;
  if ('opacity' in node) node.opacity = clamp(source.opacity, 0, 1);
  if ('resize' in node && node.type !== 'TEXT') node.resize(Math.max(0.01, source.width), Math.max(0.01, source.height));
  const blendMode = normalizePortableBlendMode(source.blendMode);
  if (blendMode && 'blendMode' in node) node.blendMode = blendMode;
  if ('fills' in node && node.type !== 'TEXT') node.fills = source.fill ? [solidPaint(source.fill)] : [];
  if ('strokes' in node) {
    node.strokes = source.stroke ? [solidPaint(source.stroke)] : [];
    if (source.stroke && 'strokeWeight' in node && source.strokeWidth !== undefined) node.strokeWeight = source.strokeWidth;
  }
  if (source.assetId) {
    node.setSharedPluginData(NAMESPACE, 'assetId', source.assetId);
    if (state?.imageHashes.has(source.assetId) && 'fills' in node) {
      node.fills = [{ type: 'IMAGE', imageHash: state.imageHashes.get(source.assetId)!, scaleMode: 'FILL' }];
      const audit = state.importedAssets.get(source.assetId);
      const metadata = state.document.assets.find((asset) => asset.assetId === source.assetId);
      if (audit) node.setSharedPluginData(NAMESPACE, 'assetIntegrity', JSON.stringify(audit));
      if (metadata) setChunkedSharedPluginData(node, 'assetMetadata', JSON.stringify(metadata));
    } else {
      node.setSharedPluginData(NAMESPACE, 'missingAssetId', source.assetId);
      recordFallback('IMAGE_ASSET_NOT_AVAILABLE', source, `Image bytes were not available for ${source.assetId}.`);
    }
  }
  if (source.cornerRadius !== undefined && node.type === 'RECTANGLE') node.cornerRadius = source.cornerRadius;
  if (source.clipPathBounds) {
    node.setSharedPluginData(NAMESPACE, 'sourceClipPathBounds', JSON.stringify(source.clipPathBounds));
  }
  if ('rotation' in node) node.rotation = source.rotation;
  node.setSharedPluginData(NAMESPACE, 'sourceGuid', source.guid);
  node.setSharedPluginData(NAMESPACE, 'sourceType', source.type);
  const layer = state?.layerRecords.get(source.guid);
  if (layer) {
    node.setSharedPluginData(NAMESPACE, 'sourceParentGuid', layer.parentGuid ?? '');
    node.setSharedPluginData(NAMESPACE, 'layerDepth', String(layer.depth));
    setChunkedSharedPluginData(node, 'layerPath', JSON.stringify(layer.path));
    node.setSharedPluginData(NAMESPACE, 'sourceArtboardBounds', JSON.stringify(layer.artboardBounds));
  }
}

function commitNodePosition(node: SceneNode, source: XdNode, contentFitOffset: { x: number; y: number }): void {
  // Text auto-sizing, vector normalization, container content fitting and
  // rotation can rewrite transforms. Commit the layer-DB-relative position last.
  const position = importedNodePosition(node, source);
  node.x = position.x + contentFitOffset.x;
  node.y = position.y + contentFitOffset.y;
  if (position.x !== source.x) node.setSharedPluginData(NAMESPACE, 'textAnchorCorrectionX', String(position.x - source.x));
  if (position.y !== source.y) node.setSharedPluginData(NAMESPACE, 'textAnchorCorrectionY', String(position.y - source.y));
  if (contentFitOffset.x || contentFitOffset.y) {
    node.setSharedPluginData(NAMESPACE, 'contentFitOffset', JSON.stringify(contentFitOffset));
  }
}

function resolvedFont(family: string, style: string): FontName | null {
  return state?.fontMappings.get(importFontKey(family, style)) ?? null;
}

function importedNodePosition(node: SceneNode, source: XdNode): { x: number; y: number } {
  if (node.type !== 'TEXT' || source.type !== 'TEXT' || source.text?.layoutBox !== 'POINT') return { x: source.x, y: source.y };
  const isLegacyDirectPackage = state?.document.issues.some((issue) => issue.code === 'XD_DIRECT_ADAPTER_USED') === true;
  const baselineData = node.getSharedPluginData(NAMESPACE, 'figmaBaselineFromTop');
  const baselineFromTop = baselineData === '' ? undefined : Number(baselineData);
  return {
    x: pointTextPositionX(
      source.x,
      node.width,
      source.text.textAlign,
      source.text.positioningMode,
      isLegacyDirectPackage,
      source.text.anchorOffsetX,
    ),
    y: pointTextPositionY(
      source.y,
      baselineFromTop,
      source.text.positioningMode,
      source.text.anchorOffsetY,
    ),
  };
}

/**
 * Figma does not expose a font-baseline metric directly. Its horizontal
 * auto-layout baseline alignment does, however, position a non-text probe's
 * bottom edge on the TextNode's first-line baseline. Measure that relation on
 * a temporary clone and cache it per resolved first-line typography.
 */
function measurePointTextBaselineFromTop(
  node: TextNode,
  fontName: FontName,
  fontSize: number,
  lineSpacing: number | undefined,
): number {
  const lineHeightKey = typeof lineSpacing === 'number' && Number.isFinite(lineSpacing) && lineSpacing > 0
    ? `PX:${lineSpacing}`
    : 'AUTO';
  const cacheKey = `${fontName.family}\u0000${fontName.style}\u0000${fontSize}\u0000${lineHeightKey}\u0000${String(node.leadingTrim)}`;
  const cached = pointTextBaselineCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const frame = figma.createFrame();
  try {
    frame.name = '__XD2FIGMA_BASELINE_PROBE__';
    // `visible = false` suspends auto-layout calculation, so keep the probe in
    // layout while making it visually transparent during the short measurement.
    frame.opacity = 0;
    frame.fills = [];
    frame.layoutMode = 'HORIZONTAL';
    frame.primaryAxisSizingMode = 'AUTO';
    frame.counterAxisSizingMode = 'AUTO';
    frame.counterAxisAlignItems = 'BASELINE';
    frame.itemSpacing = 0;

    const textProbe = node.clone();
    const edgeProbe = figma.createRectangle();
    edgeProbe.resize(1, 0.01);
    edgeProbe.fills = [];
    frame.appendChild(textProbe);
    frame.appendChild(edgeProbe);

    const baselineFromTop = edgeProbe.y + edgeProbe.height - textProbe.y;
    if (!Number.isFinite(baselineFromTop) || baselineFromTop <= 0) {
      throw new Error(`Invalid Figma baseline metric: ${baselineFromTop}`);
    }
    pointTextBaselineCache.set(cacheKey, baselineFromTop);
    return baselineFromTop;
  } finally {
    frame.remove();
  }
}

function fitContainerToContents(node: SceneNode, source: XdNode): { x: number; y: number } {
  if (
    node.type !== 'FRAME'
    || !node.children.length
    || !['GROUP', 'SYMBOL_INSTANCE', 'UNKNOWN'].includes(source.type)
    || source.clipContent === true
    || sourceIsMaskGroup(source)
    || (source.layout?.type && source.layout.type !== 'NONE')
  ) return { x: 0, y: 0 };

  const minX = Math.min(...node.children.map((child) => child.x));
  const minY = Math.min(...node.children.map((child) => child.y));
  const maxX = Math.max(...node.children.map((child) => child.x + child.width));
  const maxY = Math.max(...node.children.map((child) => child.y + child.height));
  const width = Math.max(0.01, maxX - minX);
  const height = Math.max(0.01, maxY - minY);
  for (const child of node.children) {
    child.x -= minX;
    child.y -= minY;
  }
  node.resizeWithoutConstraints(width, height);
  node.setSharedPluginData(NAMESPACE, 'contentFitBounds', JSON.stringify({ x: minX, y: minY, width, height }));
  return { x: minX, y: minY };
}

function sourceTypeSupportsChildren(type: XdNode['type']): boolean {
  return ['ARTBOARD', 'GROUP', 'SYMBOL_INSTANCE', 'REPEAT_GRID', 'SCROLLABLE_GROUP', 'Lottie', 'Video', 'UNKNOWN'].includes(type);
}

function sourceIsMaskGroup(source: XdNode): boolean {
  return source.maskGroup === true || (source.type === 'GROUP' && source.unsupported?.includes('MASK') === true);
}

function maskGuidForSource(source: XdNode, sources: Map<string, XdNode>): string | null {
  if (!sourceIsMaskGroup(source) || !source.children.length) return null;
  return source.children.find((guid) => sources.get(guid)?.isMask === true) ?? source.children[source.children.length - 1];
}

function isLikelyBackground(source: XdNode, child: XdNode): boolean {
  if (child.isBackground === true) return true;
  const fill = child.fill;
  const normalBlend = !child.blendMode || ['NORMAL', 'PASS_THROUGH'].includes(normalizePortableBlendMode(child.blendMode) ?? '');
  return child.type === 'RECTANGLE'
    && !child.assetId
    && Boolean(fill && fill.r >= 254 && fill.g >= 254 && fill.b >= 254 && fill.a >= 254)
    && child.opacity >= 0.999
    && normalBlend
    && Math.abs(child.x) <= 0.01
    && Math.abs(child.y) <= 0.01
    && Math.abs(child.width - source.width) <= 0.01
    && Math.abs(child.height - source.height) <= 0.01;
}

/** Figma masks precede the siblings they mask; XD mask shapes are topmost. */
function figmaChildOrder(source: XdNode, sources: Map<string, XdNode>): string[] {
  if (!source.children.length) return [];
  const maskGuid = maskGuidForSource(source, sources);
  const backgrounds: string[] = [];
  const regular: string[] = [];
  for (const guid of source.children) {
    if (guid === maskGuid) continue;
    const child = sources.get(guid);
    if (child && isLikelyBackground(source, child)) backgrounds.push(guid);
    else regular.push(guid);
  }
  return [...(maskGuid ? [maskGuid] : []), ...backgrounds, ...regular];
}

function applyFigmaChildRoles(source: XdNode, sources: Map<string, XdNode>, mapping: Map<string, SceneNode>): void {
  const maskGuid = maskGuidForSource(source, sources);
  if (maskGuid) {
    const mask = mapping.get(maskGuid);
    if (mask && 'isMask' in mask && 'maskType' in mask) {
      mask.isMask = true;
      mask.maskType = 'VECTOR';
      mask.setSharedPluginData(NAMESPACE, 'xdRole', 'mask');
    }
  }
  for (const guid of source.children) {
    const child = sources.get(guid);
    const target = mapping.get(guid);
    if (child && target && isLikelyBackground(source, child)) target.setSharedPluginData(NAMESPACE, 'xdRole', child.isBackground ? 'background' : 'inferred-background');
  }
}

function fallbackCodeForSource(source: XdNode): string | null {
  switch (source.type) {
    case 'SYMBOL_INSTANCE': return 'SYMBOL_INSTANCE_AS_FRAME';
    case 'REPEAT_GRID': return 'REPEAT_GRID_AS_FRAME';
    case 'Lottie': return 'LOTTIE_AS_FRAME';
    case 'Video': return 'VIDEO_AS_FRAME';
    case 'UNKNOWN': return 'UNKNOWN_NODE_AS_FRAME';
    default: return null;
  }
}

function markFallbackNode(node: SceneNode, source: XdNode, code: string, reason: string): void {
  node.setSharedPluginData(NAMESPACE, 'sourceGuid', source.guid);
  node.setSharedPluginData(NAMESPACE, 'sourceType', source.type);
  node.setSharedPluginData(NAMESPACE, 'fallbackCode', code);
  setChunkedSharedPluginData(node, 'sourceNode', JSON.stringify(source));
  recordFallback(code, source, reason);
}

function recordFallback(
  code: string,
  source: Pick<XdNode, 'guid' | 'artboardGuid' | 'type'>,
  reason: string,
): void {
  if (!state) return;
  const key = `${code}:${source.guid}:${reason}`;
  if (state.fallbacks.some((item) => `${item.code}:${item.sourceGuid}:${item.reason}` === key)) return;
  state.fallbacks.push({ code, sourceGuid: source.guid, artboardGuid: source.artboardGuid, sourceType: source.type, reason });
}

async function buildReport(page: PageNode, imported: string[], failed: Array<{ guid: string; reason: string }>): Promise<void> {
  if (!state) return;
  const reportX = Math.max(40, ...page.children.map((node) => node.x + node.width + 200));
  const reportY = Math.min(40, ...page.children.map((node) => node.y));
  page.setSharedPluginData(NAMESPACE, 'reportOriginX', String(reportX));
  page.setSharedPluginData(NAMESPACE, 'reportOriginY', String(reportY));
  if (state.reportFontName) {
    const text = figma.createText();
    page.appendChild(text);
    text.name = 'XD2Figma Import Report';
    text.fontName = state.reportFontName;
    text.characters = [
      `XD2Figma Import Report`,
      `Policy: ${IMPORT_POLICY}`,
      `Source: ${state.document.documentName}`,
      `Fingerprint: ${state.manifest.sourceFingerprint.value}`,
      `Imported: ${imported.length}`,
      `Excluded: ${state.excludedArtboards.size}`,
      `Failed validation: ${failed.length}`,
      `Font substitutions: ${state.fontSubstitutions.length}`,
      `Fallback nodes/events: ${state.fallbacks.length}`,
      '',
      ...state.issues.map((issue) => `[${issue.severity}] ${issue.code}: ${issue.message}`),
      ...failed.map((item) => `[failed] ${item.guid}: ${item.reason}`),
    ].join('\n');
    text.fontSize = 12;
    text.textAutoResize = 'WIDTH_AND_HEIGHT';
    text.x = reportX;
    text.y = reportY;
  }
  setChunkedSharedPluginData(page, 'approvals', JSON.stringify(state.approvals));
  setChunkedSharedPluginData(page, 'issues', JSON.stringify(state.issues));
  setChunkedSharedPluginData(page, 'fontAudit', JSON.stringify(state.document.fonts));
  setChunkedSharedPluginData(page, 'fontSubstitutions', JSON.stringify(state.fontSubstitutions));
  setChunkedSharedPluginData(page, 'assetAudit', JSON.stringify(state.document.assets));
  setChunkedSharedPluginData(page, 'fallbacks', JSON.stringify(state.fallbacks));
  page.setSharedPluginData(NAMESPACE, 'importPolicy', IMPORT_POLICY);
}

async function rollbackAll(): Promise<void> {
  if (!state?.stagingPages.length) return;
  const original = await figma.getNodeByIdAsync(state.originalPageId);
  if (original?.type === 'PAGE') await figma.setCurrentPageAsync(original);
  for (const page of state.stagingPages) if (!page.removed && page.getSharedPluginData(NAMESPACE, 'staging') === 'true') page.remove();
  state = null;
}

function countSubtree(root: XdNode, nodes: Map<string, XdNode>): number {
  let count = 1;
  for (const guid of root.children) {
    const child = nodes.get(guid);
    if (child) count += countSubtree(child, nodes);
  }
  return count;
}

function validateBuiltSubtree(root: XdNode, sources: Map<string, XdNode>, mapping: Map<string, SceneNode>): void {
  const visit = (source: XdNode): void => {
    const target = mapping.get(source.guid);
    if (!target) throw new Error(`STRUCTURE_MISMATCH missing=${source.guid}`);
    if (source.type === 'ARTBOARD') {
      assertClose(target.x, source.x, 'x', source.guid);
      assertClose(target.y, source.y, 'y', source.guid);
    } else {
      const layer = state?.layerRecords.get(source.guid);
      if (!layer) throw new Error(`STRUCTURE_MISMATCH layer-record=${source.guid}`);
      const actual = figmaArtboardPosition(source, sources, mapping);
      const imported = importedNodePosition(target, source);
      const fitOffset = contentFitOffset(target);
      assertClose(actual.x, layer.artboardBounds.x + imported.x - source.x + fitOffset.x, 'artboard-x', source.guid);
      assertClose(actual.y, layer.artboardBounds.y + imported.y - source.y + fitOffset.y, 'artboard-y', source.guid);
    }
    if (source.type === 'TEXT' && source.text?.layoutBox === 'POINT') {
      if (target.type !== 'TEXT' || target.textAutoResize !== 'WIDTH_AND_HEIGHT') {
        throw new Error(`STRUCTURE_MISMATCH point-text-autosize=${source.guid}`);
      }
    } else if (source.type === 'TEXT' && source.text?.layoutBox !== 'POINT') {
      assertClose(target.width, Math.max(0.01, source.width), 'width', source.guid);
      if (source.text?.layoutBox === 'AREA') {
        assertClose(target.height, Math.max(0.01, source.height), 'height', source.guid);
      }
    } else if (source.type !== 'TEXT') {
      const fitted = contentFitBounds(target);
      if (fitted) {
        assertClose(target.width, fitted.width, 'content-fit-width', source.guid);
        assertClose(target.height, fitted.height, 'content-fit-height', source.guid);
      } else {
        assertClose(target.width, Math.max(0.01, source.width), 'width', source.guid);
        assertClose(target.height, Math.max(0.01, source.height), 'height', source.guid);
      }
    }
    if ('rotation' in target) assertClose(target.rotation, source.rotation, 'rotation', source.guid);
    if ('opacity' in target) assertClose(target.opacity, clamp(source.opacity, 0, 1), 'opacity', source.guid);
    if (target.visible !== source.visible || target.locked !== source.locked) throw new Error(`STRUCTURE_MISMATCH flags=${source.guid}`);
    if (source.type === 'TEXT' && target.type === 'TEXT' && target.characters !== normalizeCharactersForFigma(source.text?.characters ?? '')) {
      throw new Error(`STRUCTURE_MISMATCH text=${source.guid}`);
    }
    if (source.fill && 'fills' in target && Array.isArray(target.fills)) {
      const paint = target.fills[0];
      if (paint?.type === 'SOLID') {
        assertClose(paint.color.r, source.fill.r / 255, 'fill.r', source.guid, 1 / 255);
        assertClose(paint.color.g, source.fill.g / 255, 'fill.g', source.guid, 1 / 255);
        assertClose(paint.color.b, source.fill.b / 255, 'fill.b', source.guid, 1 / 255);
        assertClose(paint.opacity ?? 1, source.fill.a / 255, 'fill.a', source.guid, 1 / 255);
      }
    }
    if (source.children.length) {
      if (!('children' in target)) throw new Error(`STRUCTURE_MISMATCH parent=${source.guid}`);
      const actualOrder = target.children.map((child) => child.getSharedPluginData(NAMESPACE, 'sourceGuid'));
      const expectedOrder = figmaChildOrder(source, sources);
      if (actualOrder.length !== expectedOrder.length || actualOrder.some((guid, index) => guid !== expectedOrder[index])) {
        throw new Error(`STRUCTURE_MISMATCH z-order=${source.guid}`);
      }
    }
    for (const childGuid of source.children) {
      const child = sources.get(childGuid);
      if (!child || child.parentGuid !== source.guid) throw new Error(`STRUCTURE_MISMATCH parent-link=${childGuid}`);
      visit(child);
    }
  };
  visit(root);
}

function figmaArtboardPosition(
  source: XdNode,
  sources: Map<string, XdNode>,
  mapping: Map<string, SceneNode>,
): { x: number; y: number } {
  const target = mapping.get(source.guid);
  if (!target) throw new Error(`STRUCTURE_MISMATCH missing=${source.guid}`);
  let x = target.x;
  let y = target.y;
  let parentGuid = source.parentGuid;
  const visited = new Set<string>([source.guid]);
  while (parentGuid) {
    if (visited.has(parentGuid)) throw new Error(`STRUCTURE_MISMATCH cycle=${source.guid}`);
    visited.add(parentGuid);
    const parentSource = sources.get(parentGuid);
    const parentTarget = mapping.get(parentGuid);
    if (!parentSource || !parentTarget) throw new Error(`STRUCTURE_MISMATCH parent=${source.guid}`);
    if (parentSource.type === 'ARTBOARD') break;
    x += parentTarget.x;
    y += parentTarget.y;
    parentGuid = parentSource.parentGuid;
  }
  return { x, y };
}

function contentFitOffset(node: SceneNode): { x: number; y: number } {
  const value = node.getSharedPluginData(NAMESPACE, 'contentFitOffset');
  if (!value) return { x: 0, y: 0 };
  try {
    const parsed = JSON.parse(value) as { x?: unknown; y?: unknown };
    return {
      x: typeof parsed.x === 'number' && Number.isFinite(parsed.x) ? parsed.x : 0,
      y: typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? parsed.y : 0,
    };
  } catch {
    throw new Error(`STRUCTURE_MISMATCH content-fit-offset=${node.id}`);
  }
}

function contentFitBounds(node: SceneNode): { width: number; height: number } | null {
  const value = node.getSharedPluginData(NAMESPACE, 'contentFitBounds');
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { width?: unknown; height?: unknown };
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') throw new Error('invalid');
    return { width: parsed.width, height: parsed.height };
  } catch {
    throw new Error(`STRUCTURE_MISMATCH content-fit-bounds=${node.id}`);
  }
}

function assertClose(actual: number, expected: number, field: string, guid: string, tolerance = 0.01): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance + Number.EPSILON) {
    throw new Error(`STRUCTURE_MISMATCH ${field}=${guid} expected=${expected} actual=${actual}`);
  }
}

function setChunkedSharedPluginData(node: BaseNode, prefix: string, value: string): void {
  // 20k UTF-16 code units stay below Figma's 100 kB entry limit even for 4-byte UTF-8 characters.
  const chunkSize = 20_000;
  const count = Math.ceil(value.length / chunkSize);
  node.setSharedPluginData(NAMESPACE, `${prefix}.count`, String(count));
  for (let index = 0; index < count; index += 1) {
    node.setSharedPluginData(NAMESPACE, `${prefix}.${index}`, value.slice(index * chunkSize, (index + 1) * chunkSize));
  }
}

function solidPaint(color: { r: number; g: number; b: number; a: number }): SolidPaint {
  return { type: 'SOLID', color: { r: color.r / 255, g: color.g / 255, b: color.b / 255 }, opacity: color.a / 255 };
}

function joinChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
function reportCoordinate(page: PageNode, key: 'reportOriginX' | 'reportOriginY', fallback: number): number {
  const value = Number(page.getSharedPluginData(NAMESPACE, key));
  return Number.isFinite(value) ? value : fallback;
}
function packageFatal(code: string, message: string): MigrationIssue { return { id: code.toLowerCase(), scope: 'package', severity: 'fatal', code, message, artboardGuids: [], nodeGuids: [], allowedActions: [] }; }
function deduplicateIssues(issues: MigrationIssue[]): MigrationIssue[] { const seen = new Set<string>(); return issues.filter((issue) => { const key = `${issue.code}:${issue.nodeGuids.join(',')}:${issue.artboardGuids.join(',')}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
