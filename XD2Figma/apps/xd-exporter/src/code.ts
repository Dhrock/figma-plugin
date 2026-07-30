import {
  COORDINATE_CSV_HEADER,
  V1_LIMITS,
  buildOutputFolderName,
  createDocumentFingerprintAccumulator,
  encodeCoordinateCsvRow,
  formatDateStamp,
  nextOutputTestNumber,
  normalizePortableBlendMode,
  sanitizeOutputStem,
  stableStringify,
  type FontAuditRecord,
  type MigrationIssue,
  type XdAsset,
  type XdColor,
  type XdCoordinateRecord,
  type XdDocument,
  type XdNode,
  type XdNodeType,
  type XdTextRange,
} from '../../../packages/core/src';
import { collectionToArray, forEachCollection } from './collection';

declare const module: { exports: unknown };
declare function require(name: string): any;

const interactions = require('interactions');
const application = require('application');
const localFileSystem = require('uxp').storage.localFileSystem;

interface XdSelection { items: any[] }
interface ExportStats { artboards: number; nodes: number; coordinates: number; outputFolderName: string }
interface ProgressDialog {
  setMessage(message: string): void;
  isCancelled(): boolean;
  close(): Promise<void>;
}

interface NodeIndexEntry { artboardGuid: string | null }
interface StreamStats { nodeCount: number; nodesWritten: number }

const NODE_CHUNK_SIZE = 100;

async function exportXd2Figma(_selection: XdSelection, documentRoot: any): Promise<void> {
  const outputRoot = await localFileSystem.getFolder();
  if (!outputRoot) return;
  const documentName = safeDocumentName(application.activeDocument?.name ?? documentRoot.name ?? 'Untitled');
  const progress = showProgressDialog();
  await yieldToHost();
  try {
    progress.setMessage('Creating a named output folder…');
    const outputFolder = await createNumberedOutputFolder(outputRoot, documentName, new Date());
    const stats = await performExport(
      documentRoot,
      outputFolder,
      documentName,
      (message) => progress.setMessage(message),
      () => progress.isCancelled(),
    );
    await progress.close();
    await showMessageDialog(
      'XD2Figma export complete',
      `${stats.artboards} artboards, ${stats.nodes} nodes, and ${stats.coordinates} coordinate rows were exported to ${stats.outputFolderName}. Reference images are not generated.`,
    );
  } catch (error) {
    await progress.close();
    const message = error instanceof Error ? error.message : String(error);
    console.error('XD2Figma export failed', error);
    try {
      await showMessageDialog('XD2Figma export failed', message);
    } catch (dialogError) {
      console.error('XD2Figma could not show its error dialog', dialogError);
    }
  }
}

async function performExport(
  documentRoot: any,
  outputFolder: any,
  documentName: string,
  updateProgress: (message: string) => void,
  isCancelled: () => boolean,
): Promise<ExportStats> {
  const semanticFile = await outputFolder.createFile('semantic.json', { overwrite: true });
  const coordinateFile = await outputFolder.createFile('coordinates.csv', { overwrite: true });
  await semanticFile.write('{"nodes":[\n');
  await coordinateFile.write(`${COORDINATE_CSV_HEADER}\n`);
  const nodeBuffer: XdNode[] = [];
  const coordinateBuffer: XdCoordinateRecord[] = [];
  const fingerprint = createDocumentFingerprintAccumulator();
  const artboardGuids: string[] = [];
  const fontMap = new Map<string, FontAuditRecord>();
  const assetMap = new Map<string, XdAsset>();
  const issues: MigrationIssue[] = [];
  const nodeIndex = new Map<string, NodeIndexEntry>();
  const visitedGuids = new Set<string>();
  const streamStats: StreamStats = { nodeCount: 0, nodesWritten: 0 };

  const flushNodes = async (): Promise<void> => {
    if (!nodeBuffer.length) return;
    const prefix = streamStats.nodesWritten > 0 ? ',\n' : '';
    const chunk = prefix + nodeBuffer.map((node) => stableStringify(node)).join(',\n');
    await semanticFile.write(chunk, { append: true });
    await coordinateFile.write(`${coordinateBuffer.map(encodeCoordinateCsvRow).join('\n')}\n`, { append: true });
    streamStats.nodesWritten += nodeBuffer.length;
    nodeBuffer.length = 0;
    coordinateBuffer.length = 0;
  };

  const emitNode = async (node: XdNode, coordinate: XdCoordinateRecord): Promise<void> => {
    fingerprint.addNode(node);
    nodeIndex.set(node.guid, { artboardGuid: node.artboardGuid });
    nodeBuffer.push(node);
    coordinateBuffer.push(coordinate);
    streamStats.nodeCount += 1;
    if (streamStats.nodeCount > V1_LIMITS.nodes) throw new Error(`PACKAGE_TOO_LARGE: node count exceeds ${V1_LIMITS.nodes}.`);
    if (nodeBuffer.length >= NODE_CHUNK_SIZE) await flushNodes();
  };

  updateProgress('Reading XD nodes…');
  await collectNodes(documentRoot, emitNode, artboardGuids, fontMap, assetMap, issues, nodeIndex, visitedGuids, updateProgress, isCancelled);
  await flushNodes();
  appendInteractionIssues(nodeIndex, issues);
  updateProgress('Calculating source fingerprint…');
  await yieldToHost();
  throwIfCancelled(isCancelled);
  const fingerprintValue = await fingerprint.finish(artboardGuids);
  const documentTail: Omit<XdDocument, 'nodes'> = {
    documentName,
    sourceFingerprint: { algorithm: 'sha256', value: fingerprintValue, nodeCount: streamStats.nodeCount, artboardCount: artboardGuids.length },
    coordinateSpace: 'XD_SCENEGRAPH_RAW_V1',
    artboardGuids,
    fonts: [...fontMap.values()],
    assets: [...assetMap.values()],
    references: [],
    issues,
  };
  updateProgress('Writing semantic.json…');
  const tailEntries = Object.entries(documentTail)
    .map(([key, value]) => `${JSON.stringify(key)}:${stableStringify(value)}`)
    .join(',\n');
  await semanticFile.write(`\n],\n${tailEntries}\n}\n`, { append: true });
  const markerFile = await outputFolder.createFile('export-complete.json', { overwrite: true });
  await markerFile.write(stableStringify({ sourceFingerprint: fingerprintValue, nodeCount: streamStats.nodeCount, coordinateCount: streamStats.nodeCount, artboardCount: artboardGuids.length }));
  console.log(`XD2Figma: exported ${artboardGuids.length} artboards and ${streamStats.nodeCount} nodes`);
  return { artboards: artboardGuids.length, nodes: streamStats.nodeCount, coordinates: streamStats.nodeCount, outputFolderName: outputFolder.name };
}

async function createNumberedOutputFolder(outputRoot: any, documentName: string, date: Date): Promise<any> {
  const dateStamp = formatDateStamp(date);
  const entries = await outputRoot.getEntries();
  const entryNames = collectionToArray<any>(entries).map((entry) => String(entry.name ?? ''));
  const testNumber = nextOutputTestNumber(entryNames, dateStamp, documentName);
  const folderName = buildOutputFolderName(dateStamp, documentName, testNumber);
  return outputRoot.createFolder(folderName);
}

async function collectNodes(
  documentRoot: any,
  emitNode: (node: XdNode, coordinate: XdCoordinateRecord) => Promise<void>,
  artboards: string[],
  fonts: Map<string, FontAuditRecord>,
  assets: Map<string, XdAsset>,
  issues: MigrationIssue[],
  nodeIndex: Map<string, NodeIndexEntry>,
  visitedGuids: Set<string>,
  updateProgress: (message: string) => void,
  isCancelled: () => boolean,
): Promise<void> {
  const pending: Array<{ raw: any; parentGuid: string | null; artboardGuid: string | null; artboardOrigin: { x: number; y: number } | null; zOrder: number }> = [];
  const roots: any[] = [];
  forEachCollection<any>(documentRoot.children, (raw) => roots.push(raw));
  for (let index = roots.length - 1; index >= 0; index -= 1) pending.push({ raw: roots[index], parentGuid: null, artboardGuid: null, artboardOrigin: null, zOrder: index });
  while (pending.length) {
    throwIfCancelled(isCancelled);
    const current = pending.pop()!;
    const rawGuid = String(current.raw?.guid ?? '');
    if (!rawGuid) throw new Error('SOURCE_GRAPH_INVALID: a scene node has no GUID.');
    if (visitedGuids.has(rawGuid)) throw new Error(`SOURCE_GRAPH_INVALID: duplicate or cyclic GUID ${rawGuid}.`);
    visitedGuids.add(rawGuid);
    const visited = visitNode(current.raw, current.parentGuid, current.artboardGuid, current.artboardOrigin, current.zOrder, artboards, fonts, assets, issues);
    await emitNode(visited.node, visited.coordinate);
    for (let index = visited.children.length - 1; index >= 0; index -= 1) {
      pending.push({ raw: visited.children[index], parentGuid: visited.guid, artboardGuid: visited.artboardGuid, artboardOrigin: visited.artboardOrigin, zOrder: index });
    }
    if (visitedGuids.size % 250 === 0) {
      updateProgress(`Reading XD nodes… ${visitedGuids.size}`);
      await yieldToHost();
    }
  }
  updateProgress(`Read ${visitedGuids.size} XD nodes.`);
}

function visitNode(
  raw: any,
  parentGuid: string | null,
  inheritedArtboardGuid: string | null,
  inheritedArtboardOrigin: { x: number; y: number } | null,
  zOrder: number,
  artboards: string[],
  fonts: Map<string, FontAuditRecord>,
  assets: Map<string, XdAsset>,
  issues: MigrationIssue[],
): { guid: string; artboardGuid: string | null; artboardOrigin: { x: number; y: number } | null; children: any[]; node: XdNode; coordinate: XdCoordinateRecord } {
  const guid = String(raw.guid);
  const type = mapNodeType(raw);
  const artboardGuid = type === 'ARTBOARD' ? guid : inheritedArtboardGuid;
  if (type === 'ARTBOARD') artboards.push(guid);
  const rawChildren = collectionToArray<any>(raw.children);
  const children = rawChildren.map((child) => String(child.guid));
  const bounds = raw.localBounds ?? { x: 0, y: 0, width: raw.width ?? 0, height: raw.height ?? 0 };
  const topLeft = raw.topLeftInParent ?? { x: raw.boundsInParent?.x ?? 0, y: raw.boundsInParent?.y ?? 0 };
  const globalBounds = raw.globalBounds ?? raw.boundsInParent ?? topLeft;
  const artboardOrigin = type === 'ARTBOARD'
    ? { x: number(globalBounds.x), y: number(globalBounds.y) }
    : inheritedArtboardOrigin;
  const pathData = type === 'PATH' || type === 'BOOLEAN_GROUP'
    ? (typeof raw.pathData === 'string' ? raw.pathData : undefined)
    : undefined;
  const node: XdNode = {
    guid,
    type,
    name: String(raw.name ?? type),
    parentGuid,
    artboardGuid,
    children,
    x: number(topLeft.x),
    y: number(topLeft.y),
    width: number(bounds.width),
    height: number(bounds.height),
    rotation: number(raw.rotation ?? raw.transform?.rotation ?? 0),
    visible: raw.visible !== false,
    locked: raw.locked === true,
    opacity: clamp(number(raw.opacity ?? 1), 0, 1),
    fill: serializeColor(raw.fill),
    stroke: serializeColor(raw.stroke),
    strokeWidth: optionalNumber(raw.strokeWidth),
    cornerRadius: optionalNumber(raw.cornerRadii?.topLeft ?? raw.cornerRadius),
    polygonPointCount: type === 'POLYGON' ? optionalNumber(raw.pointCount) : undefined,
    blendMode: raw.blendMode ? String(raw.blendMode) : undefined,
    isBackground: Boolean(raw.parent?.layout?.padding?.background === raw),
    maskGroup: Boolean(raw.mask),
    isMask: Boolean(raw.isMask),
    clipContent: Boolean(raw.clipContent),
    viewportHeight: raw.viewportHeight === null ? null : optionalNumber(raw.viewportHeight),
    fixedWhenScrolling: raw.fixedWhenScrolling === true,
    sourcePathData: pathData,
    pathData,
    windingRule: raw.fillRule === 'evenodd' ? 'EVENODD' : 'NONZERO',
    layout: serializeLayout(raw.layout),
    unsupported: detectUnsupported(raw),
  };

  if (type === 'TEXT') {
    node.text = serializeText(raw, guid, fonts);
  }
  const fill = raw.fill;
  if (fill?.assetId) {
    const assetId = String(fill.assetId);
    node.assetId = assetId;
    const existing = assets.get(assetId);
    const usage = { nodeGuid: guid, artboardGuid: artboardGuid ?? 'pasteboard' };
    if (existing) existing.usages.push(usage);
    else assets.set(assetId, {
      assetId,
      path: `resources/${assetId}`,
      sha256: '',
      mimeType: normalizeMime(fill.mimeType),
      width: number(fill.naturalWidth),
      height: number(fill.naturalHeight),
      originalFileName: null,
      iccProfile: null,
      exif: null,
      usages: [usage],
    });
  }
  if (type === 'UNKNOWN') issues.push(blocker(node, 'UNSUPPORTED_XD_FEATURE', `未知のXDノード: ${raw.constructor?.name ?? 'unknown'}`));
  const coordinate: XdCoordinateRecord = {
    guid,
    parentGuid,
    artboardGuid: artboardGuid ?? guid,
    zOrder,
    artboardX: type === 'ARTBOARD' ? 0 : artboardOrigin ? number(globalBounds.x) - artboardOrigin.x : number(topLeft.x),
    artboardY: type === 'ARTBOARD' ? 0 : artboardOrigin ? number(globalBounds.y) - artboardOrigin.y : number(topLeft.y),
  };
  return { guid, artboardGuid, artboardOrigin, children: rawChildren, node, coordinate };
}

function serializeText(raw: any, guid: string, fonts: Map<string, FontAuditRecord>): XdNode['text'] {
  const styleRanges: XdTextRange[] = collectionToArray<any>(raw.styleRanges).map((range) => {
    const fontFamily = String(range.fontFamily ?? raw.fontFamily ?? '');
    const fontStyle = String(range.fontStyle ?? raw.fontStyle ?? 'Regular');
    const key = `${fontFamily}\u0000${fontStyle}`;
    const audit = fonts.get(key) ?? { family: fontFamily, style: fontStyle, postscriptName: null, version: null, vendor: null, license: null, fsType: null, fileSha256: null, nodeGuids: [] };
    if (!audit.nodeGuids.includes(guid)) audit.nodeGuids.push(guid);
    fonts.set(key, audit);
    return {
      length: number(range.length),
      fontFamily,
      fontStyle,
      fontSize: number(range.fontSize ?? raw.fontSize),
      fill: serializeColor(range.fill ?? raw.fill),
      charSpacing: number(range.charSpacing ?? raw.charSpacing ?? 0),
      lineSpacing: optionalNumber(range.lineSpacing ?? raw.lineSpacing),
      underline: Boolean(range.underline),
      strikethrough: Boolean(range.strikethrough),
      textTransform: normalizeTextTransform(range.textTransform),
      textScript: normalizeTextScript(range.textScript),
    };
  });
  if (!styleRanges.length) {
    const fontFamily = String(raw.fontFamily ?? '');
    const fontStyle = String(raw.fontStyle ?? 'Regular');
    styleRanges.push({ length: String(raw.text ?? '').length, fontFamily, fontStyle, fontSize: number(raw.fontSize), fill: serializeColor(raw.fill), charSpacing: number(raw.charSpacing ?? 0), lineSpacing: optionalNumber(raw.lineSpacing), underline: Boolean(raw.underline), strikethrough: Boolean(raw.strikethrough), textTransform: 'none', textScript: 'none' });
  }
  const layoutType = raw.layoutBox?.type ?? (raw.areaBox ? 'area' : 'point');
  return {
    characters: String(raw.text ?? ''),
    styleRanges,
    layoutBox: layoutType === 'point' ? 'POINT' : layoutType === 'auto-height' ? 'AUTO_HEIGHT' : 'AREA',
    textAlign: raw.textAlign === 'center' ? 'CENTER' : raw.textAlign === 'right' ? 'RIGHT' : 'LEFT',
    clippedByArea: raw.clippedByArea === true,
    width: optionalNumber(raw.layoutBox?.width ?? raw.areaBox?.width),
    height: optionalNumber(raw.layoutBox?.height ?? raw.areaBox?.height),
    positioningMode: 'TOP_LEFT',
  };
}

function serializeLayout(layout: any): XdNode['layout'] {
  if (!layout || layout.type === undefined) return { type: 'NONE' };
  const stack = layout.stack;
  const padding = layout.padding?.values;
  return {
    type: stack ? 'STACK' : padding ? 'PADDING' : layout.resizeConstraints ? 'RESPONSIVE' : 'NONE',
    orientation: stack?.orientation === 'horizontal' ? 'HORIZONTAL' : stack ? 'VERTICAL' : undefined,
    spacing: stack?.spacings,
    padding: padding === undefined ? undefined : typeof padding === 'number' ? { top: padding, right: padding, bottom: padding, left: padding } : { top: number(padding.top), right: number(padding.right), bottom: number(padding.bottom), left: number(padding.left) },
  };
}

function detectUnsupported(raw: any): string[] {
  const result: string[] = [];
  if (number(raw.rotationX) !== 0 || number(raw.rotationY) !== 0 || number(raw.perspective) !== 0) result.push('THREE_D_TRANSFORM');
  if (raw.blur?.brightness !== undefined && number(raw.blur.brightness) !== 0) result.push('BACKGROUND_BLUR_BRIGHTNESS');
  if (raw.constructor?.name === 'SymbolInstance' && raw.isComponentState === true) result.push('COMPONENT_STATE');
  if (raw.fill?.colorStops) result.push('GRADIENT_FILL');
  if (raw.shadow || raw.blur && (raw.blur.blurAmount || raw.blur.backgroundEffect)) result.push('EFFECTS');
  if (raw.blendMode && !normalizePortableBlendMode(String(raw.blendMode))) result.push('BLEND_MODE');
  return result;
}

function appendInteractionIssues(nodeIndex: Map<string, NodeIndexEntry>, issues: MigrationIssue[]): void {
  for (const group of collectionToArray<any>(interactions.allInteractions)) {
    const triggerGuid = String(group.triggerNode?.guid ?? '');
    const entry = nodeIndex.get(triggerGuid);
    if (!entry) continue;
    const node = { guid: triggerGuid, artboardGuid: entry.artboardGuid };
    for (const interaction of collectionToArray<any>(group.interactions)) {
      const trigger = interaction.trigger?.type;
      const action = interaction.action?.type;
      if (trigger === 'voice' || action === 'speak') issues.push({ ...blocker(node, 'PROTOTYPE_FEATURE_OMIT', '音声プロトタイプは明示承認後に省略できます。'), severity: 'approvable', allowedActions: ['OMIT_PROTOTYPE_FEATURE'] });
    }
  }
}

function mapNodeType(raw: any): XdNodeType {
  const type = String(raw.constructor?.name ?? 'UNKNOWN');
  const map: Record<string, XdNodeType> = { Artboard: 'ARTBOARD', Group: 'GROUP', Rectangle: 'RECTANGLE', Ellipse: 'ELLIPSE', Line: 'LINE', Polygon: 'POLYGON', Path: 'PATH', BooleanGroup: 'BOOLEAN_GROUP', Text: 'TEXT', SymbolInstance: 'SYMBOL_INSTANCE', RepeatGrid: 'REPEAT_GRID', ScrollableGroup: 'SCROLLABLE_GROUP', Lottie: 'Lottie', Video: 'Video' };
  return map[type] ?? 'UNKNOWN';
}

function serializeColor(value: any): XdColor | undefined {
  if (!value || value.assetId || value.colorStops) return undefined;
  const r = optionalNumber(value.r);
  const g = optionalNumber(value.g);
  const b = optionalNumber(value.b);
  if (r === undefined || g === undefined || b === undefined) return undefined;
  return { r, g, b, a: optionalNumber(value.a) ?? 255 };
}

function blocker(node: Pick<XdNode, 'guid' | 'artboardGuid'>, code: string, message: string): MigrationIssue {
  return { id: `${code.toLowerCase()}-${node.guid}`, scope: 'node', severity: 'blocker', code, message, artboardGuids: node.artboardGuid ? [node.artboardGuid] : [], nodeGuids: [node.guid], allowedActions: [] };
}

function normalizeMime(value: string | undefined): XdAsset['mimeType'] {
  if (value === 'image/gif') return 'image/gif';
  if (value === 'image/jpeg') return 'image/jpeg';
  return 'image/png';
}

function normalizeTextTransform(value: string | undefined): XdTextRange['textTransform'] {
  return value === 'uppercase' || value === 'lowercase' || value === 'titlecase' ? value : 'none';
}

function normalizeTextScript(value: string | undefined): XdTextRange['textScript'] {
  return value === 'superscript' || value === 'subscript' ? value : 'none';
}

function number(value: unknown): number { const converted = Number(value); return Number.isFinite(converted) ? converted : 0; }
function optionalNumber(value: unknown): number | undefined { if (value === null || value === undefined) return undefined; const converted = Number(value); return Number.isFinite(converted) ? converted : undefined; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
function safeDocumentName(value: string): string { return sanitizeOutputStem(value); }
function showProgressDialog(): ProgressDialog {
  const dialog = document.createElement('dialog');
  const form = document.createElement('form');
  const heading = document.createElement('h1');
  heading.textContent = 'Exporting for XD2Figma';
  const description = document.createElement('p');
  description.textContent = 'Preparing export…';
  const footer = document.createElement('footer');
  const cancelButton = document.createElement('button');
  cancelButton.textContent = 'Cancel';
  cancelButton.setAttribute('type', 'button');
  footer.appendChild(cancelButton);
  form.appendChild(heading);
  form.appendChild(description);
  form.appendChild(footer);
  dialog.appendChild(form);
  document.body.appendChild(dialog);
  const modal = Promise.resolve((dialog as any).showModal());
  let closed = false;
  let cancelled = false;
  cancelButton.addEventListener('click', () => {
    cancelled = true;
    description.textContent = 'Cancelling…';
    (cancelButton as any).disabled = true;
  });
  return {
    setMessage(message: string): void { description.textContent = message; },
    isCancelled(): boolean { return cancelled; },
    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        (dialog as any).close();
      }
      try { await modal; } catch { /* The export result is reported separately. */ }
      dialog.remove();
    },
  };
}

async function showMessageDialog(title: string, message: string): Promise<void> {
  const dialog = document.createElement('dialog');
  const form = document.createElement('form');
  form.setAttribute('method', 'dialog');
  const heading = document.createElement('h1');
  heading.textContent = title;
  const description = document.createElement('p');
  description.textContent = message;
  const footer = document.createElement('footer');
  const button = document.createElement('button');
  button.textContent = 'OK';
  button.setAttribute('type', 'submit');
  button.setAttribute('uxp-variant', 'cta');
  footer.appendChild(button);
  form.appendChild(heading);
  form.appendChild(description);
  form.appendChild(footer);
  dialog.appendChild(form);
  document.body.appendChild(dialog);
  try { await (dialog as any).showModal(); } finally { dialog.remove(); }
}

function yieldToHost(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)); }
function throwIfCancelled(isCancelled: () => boolean): void {
  if (isCancelled()) throw new Error('Export cancelled by user. The incomplete semantic.json must not be imported.');
}

module.exports = { commands: { exportXd2Figma } };
