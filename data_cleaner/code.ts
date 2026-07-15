type Scope = 'selection' | 'artboards' | 'page';

type Options = {
  removeAnnotations: boolean;
  removeTextStyles: boolean;
  convertGroups: boolean;
  createAnnotationTable: boolean;
};

type RunMessage = {
  type: 'run';
  scope: Scope;
  options: Options;
  fileUrl: string;
};

type UiMessage = RunMessage | { type: 'cancel' };

type Stats = {
  annotations: number;
  textStyles: number;
  groups: number;
  tableRows: number;
  absoluteAnnotations: number;
  errors: string[];
  warnings: string[];
};

type AnnotationRow = {
  content: string;
  tag: string;
  artboardName: string;
  nodeId: string;
  linkTargetId: string;
  nodeUrl: string | null;
  sourceNode: SceneNode;
  markerAnnotationContent: string | null;
};

type AnnotatableSceneNode = SceneNode & { annotations: ReadonlyArray<Annotation> };

type LayoutChildSettings = {
  constraints?: Constraints;
  layoutAlign?: unknown;
  layoutGrow?: unknown;
  layoutPositioning?: unknown;
  layoutSizingHorizontal?: unknown;
  layoutSizingVertical?: unknown;
  minWidth?: unknown;
  maxWidth?: unknown;
  minHeight?: unknown;
  maxHeight?: unknown;
};

let fallbackFileKey = '';

const FONT_REGULAR: FontName = { family: 'Inter', style: 'Regular' };
const FONT_BOLD: FontName = { family: 'Inter', style: 'Bold' };
const MARKER_PLUGIN_KEY = 'annotation-link-marker';
const MARKER_PLUGIN_VALUE = 'true';
const ABSOLUTE_POSITION_ANNOTATION = '絶対位置を使用しています。フレーム化前に通常配置へ変更してください。';

figma.showUI(__html__, { width: 360, height: 470, themeColors: true });

figma.ui.onmessage = async (msg: UiMessage) => {
  if (msg.type === 'cancel') {
    figma.closePlugin();
    return;
  }

  if (msg.type !== 'run') return;

  try {
    fallbackFileKey = extractFileKey(msg.fileUrl) || fallbackFileKey;
    const stats = await runCleaner(msg.scope, msg.options);
    figma.ui.postMessage({ type: 'result', stats });
    figma.notify(buildNotifyMessage(stats));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    figma.ui.postMessage({ type: 'error', message });
    figma.notify(message, { error: true });
  }
};

async function runCleaner(scope: Scope, options: Options): Promise<Stats> {
  const stats: Stats = {
    annotations: 0,
    textStyles: 0,
    groups: 0,
    tableRows: 0,
    absoluteAnnotations: 0,
    errors: [],
    warnings: [],
  };

  const artboards = scope === 'artboards' ? getSelectedArtboards() : [];
  const nodes = getNodesForScope(scope, artboards);
  const absoluteNodes = options.convertGroups ? getAbsolutePositionedNodes(nodes) : [];
  const shouldSkipGroups = absoluteNodes.length > 0;

  if (options.removeTextStyles) {
    const styles = await figma.getLocalTextStylesAsync();
    for (const style of styles) {
      style.remove();
      stats.textStyles += 1;
    }
  }

  if (options.removeAnnotations) {
    stats.annotations += removeAnnotations(nodes, stats);
  }

  if (shouldSkipGroups) {
    stats.warnings.push(buildAbsolutePositionSkipMessage());
    const rows = collectAbsolutePositionAnnotationRows(absoluteNodes);
    stats.tableRows = rows.length;
    await createAnnotationTables(rows, stats);
    return stats;
  }

  if (options.convertGroups) {
    stats.groups += convertGroupsToFrames(nodes, stats).length;
  }

  if (options.createAnnotationTable) {
    const rows = await collectAnnotationRows(
      scope === 'selection'
        ? [{ artboardName: '', nodes }]
        : getAnnotationTargets(scope, artboards),
    );
    stats.tableRows = rows.length;
    await createAnnotationTables(rows, stats);
  }

  return stats;
}

function collectNodesFromRoots(roots: ReadonlyArray<SceneNode>): SceneNode[] {
  const nodes: SceneNode[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    walkScene(root, (node) => {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        nodes.push(node);
      }
    });
  }

  return nodes;
}

function getNodesForScope(scope: Scope, artboards: FrameNode[]): SceneNode[] {
  if (scope === 'selection') return collectNodesFromRoots(figma.currentPage.selection);
  if (scope === 'artboards') return collectNodesFromRoots(artboards);
  return collectNodesFromRoots(figma.currentPage.children);
}

function getAnnotationTargets(
  scope: Scope,
  artboards: FrameNode[],
): Array<{ artboardName: string; nodes: SceneNode[] }> {
  if (scope === 'artboards') {
    return artboards.map((artboard) => ({
      artboardName: getSafeName(artboard),
      nodes: collectNodesFromRoots([artboard]),
    }));
  }

  return getTopLevelArtboards().map((artboard) => ({
    artboardName: getSafeName(artboard),
    nodes: collectNodesFromRoots([artboard]),
  })).concat([{ artboardName: 'ページ直下', nodes: getNodesOutsideTopLevelArtboards() }]);
}

function getTopLevelArtboards(): FrameNode[] {
  return figma.currentPage.children.filter((node): node is FrameNode => node.type === 'FRAME');
}

function getNodesOutsideTopLevelArtboards(): SceneNode[] {
  const roots = figma.currentPage.children.filter((node) => node.type !== 'FRAME');
  return collectNodesFromRoots(roots);
}

function hasAncestorInSet(node: BaseNode, ids: Set<string>): boolean {
  let parent = node.parent;

  while (parent && parent.type !== 'PAGE') {
    if (ids.has(parent.id)) return true;
    parent = parent.parent;
  }

  return false;
}

function getSelectedArtboards(): FrameNode[] {
  const artboards = figma.currentPage.selection.filter((node): node is FrameNode => node.type === 'FRAME');
  if (!artboards.length) {
    throw new Error('アートボード(Frame)を選択してください。');
  }
  return artboards;
}

function walkScene(node: SceneNode, visit: (node: SceneNode) => void) {
  try {
    if (node.removed) return;
    visit(node);
    if ('children' in node) {
      for (const child of node.children) {
        walkScene(child, visit);
      }
    }
  } catch (_error) {
    return;
  }
}

function removeAnnotations(nodes: SceneNode[], stats: Stats): number {
  let count = 0;

  for (const node of nodes) {
    if (!('annotations' in node)) continue;

    const annotatable = node as SceneNode & { annotations: ReadonlyArray<Annotation> };
    if (!annotatable.annotations.length) continue;

    try {
      const annotationCount = annotatable.annotations.length;
      (annotatable as SceneNode & { annotations: Annotation[] }).annotations = [];
      count += annotationCount;
    } catch (_error) {
      stats.errors.push(`${getSafeName(node)}: アノテーション削除に失敗`);
    }
  }

  return count;
}

function convertGroupsToFrames(nodes: SceneNode[], stats: Stats): FrameNode[] {
  const frames: FrameNode[] = [];
  const allGroups = nodes.filter((node): node is GroupNode => node.type === 'GROUP');
  const groupIds = new Set<string>();

  for (const group of allGroups) {
    groupIds.add(group.id);
  }

  const groups = allGroups
    .filter((group) => !hasAncestorInSet(group, groupIds))
    .sort((a, b) => getNodeDepth(a) - getNodeDepth(b));

  for (const group of groups) {
    if (isRemoved(group) || !group.parent || !('children' in group.parent)) continue;

    const groupName = getSafeName(group);
    if (isInsideInstance(group)) {
      stats.warnings.push(`${groupName}: Instance内のためフレーム化をスキップ`);
      continue;
    }
    try {
      const parent = group.parent;
      const index = parent.children.indexOf(group);
      const parentUsesAutoLayout = isAutoLayoutContainer(parent);
      const layoutSettings = captureLayoutChildSettings(group);
      const children = group.children.map((child) => ({
        node: child,
        absoluteTransform: cloneTransform(child.absoluteTransform),
        absoluteX: child.absoluteBoundingBox ? child.absoluteBoundingBox.x : undefined,
        absoluteY: child.absoluteBoundingBox ? child.absoluteBoundingBox.y : undefined,
      }));
      const frame = figma.createFrame();
      const groupTransform = cloneTransform(group.relativeTransform);

      frame.name = groupName;
      frame.x = group.x;
      frame.y = group.y;
      frame.rotation = group.rotation;
      frame.visible = group.visible;
      frame.locked = group.locked;
      frame.opacity = group.opacity;
      frame.resizeWithoutConstraints(group.width, group.height);
      frame.fills = [];
      frame.clipsContent = false;
      setNodeProperty(frame, 'effects', readNodeProperty(group, 'effects'));
      setNodeProperty(frame, 'blendMode', readNodeProperty(group, 'blendMode'));
      setNodeProperty(frame, 'exportSettings', readNodeProperty(group, 'exportSettings'));
      if (hasAnnotations(group) && group.annotations.length) {
        setNodeProperty(frame, 'annotations', normalizeAnnotationsForSet(group.annotations));
      }

      applyLayoutChildPositionSettings(frame, layoutSettings);
      parent.insertChild(index, frame);
      if (parentUsesAutoLayout) {
        setNodeProperty(frame, 'rotation', group.rotation);
      } else {
        setRelativeTransform(frame, groupTransform);
      }
      applyLayoutChildPositionSettings(frame, layoutSettings);
      let frameReferenceTransform = cloneTransform(frame.absoluteTransform);
      const frameBox = frame.absoluteBoundingBox;
      for (const child of children) {
        frame.appendChild(child.node);
        const childTransform = multiplyTransforms(invertTransform(frameReferenceTransform), child.absoluteTransform);
        if (!setRelativeTransform(child.node, childTransform) && frameBox && child.absoluteX !== undefined && child.absoluteY !== undefined) {
          child.node.x = child.absoluteX - frameBox.x;
          child.node.y = child.absoluteY - frameBox.y;
        }
      }
      if (!safeRemove(group)) {
        stats.warnings.push(`${groupName}: 元Groupは既に削除済みです`);
      }
      applyLayoutChildSizeSettings(frame, layoutSettings);
      const finalFrameTransform = cloneTransform(frame.absoluteTransform);
      if (!transformsNearlyEqual(frameReferenceTransform, finalFrameTransform)) {
        frameReferenceTransform = finalFrameTransform;
        for (const child of children) {
          const childTransform = multiplyTransforms(invertTransform(frameReferenceTransform), child.absoluteTransform);
          setRelativeTransform(child.node, childTransform);
        }
      }
      ungroupNestedGroups(frame, stats);
      frames.push(frame);
    } catch (error) {
      stats.errors.push(`${groupName}: フレーム化に失敗 (${formatError(error)})`);
    }
  }

  if (frames.length) {
    figma.currentPage.selection = frames.filter((frame) => frame.parent === figma.currentPage);
  }

  return frames;
}

function ungroupNestedGroups(container: FrameNode, stats: Stats): number {
  let count = 0;
  let guard = 0;

  while (guard < 10000) {
    guard += 1;
    const group = findNestedGroup(container);
    if (!group) return count;

    const groupName = getSafeName(group);
    try {
      if (ungroupSingleGroup(group)) {
        count += 1;
      } else {
        stats.warnings.push(`${groupName}: 内包Group解除をスキップ`);
      }
    } catch (error) {
      stats.errors.push(`${groupName}: 内包Group解除に失敗 (${formatError(error)})`);
    }
  }

  stats.warnings.push(`${getSafeName(container)}: 内包Group解除が多すぎるため途中で停止`);
  return count;
}

function findNestedGroup(node: SceneNode): GroupNode | null {
  if (!('children' in node)) return null;

  for (const child of node.children) {
    if (child.type === 'INSTANCE') continue;
    if (child.type === 'GROUP') return child;

    const nested = findNestedGroup(child);
    if (nested) return nested;
  }

  return null;
}

function ungroupSingleGroup(group: GroupNode): boolean {
  if (isRemoved(group) || !group.parent || !('children' in group.parent)) return false;

  const parent = group.parent;
  const index = parent.children.indexOf(group);
  const parentTransform = getAbsoluteTransform(parent);
  const parentBox = getAbsoluteBoundingBox(parent);
  const children = group.children.map((child) => ({
    node: child,
    absoluteTransform: cloneTransform(child.absoluteTransform),
    absoluteX: child.absoluteBoundingBox ? child.absoluteBoundingBox.x : undefined,
    absoluteY: child.absoluteBoundingBox ? child.absoluteBoundingBox.y : undefined,
  }));

  for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
    const child = children[childIndex];
    parent.insertChild(index + childIndex, child.node);

    if (parentTransform) {
      const childTransform = multiplyTransforms(invertTransform(parentTransform), child.absoluteTransform);
      if (setRelativeTransform(child.node, childTransform)) continue;
    }

    if (parentBox && child.absoluteX !== undefined && child.absoluteY !== undefined) {
      child.node.x = child.absoluteX - parentBox.x;
      child.node.y = child.absoluteY - parentBox.y;
    }
  }

  safeRemove(group);
  return true;
}

function getAbsoluteTransform(node: BaseNode): Transform | null {
  try {
    if ('absoluteTransform' in node) {
      return cloneTransform((node as SceneNode).absoluteTransform);
    }
  } catch (_error) {
    return null;
  }

  return null;
}

function getAbsoluteBoundingBox(node: BaseNode): Rect | null {
  try {
    if ('absoluteBoundingBox' in node) {
      return (node as SceneNode).absoluteBoundingBox;
    }
  } catch (_error) {
    return null;
  }

  return null;
}

function captureLayoutChildSettings(node: SceneNode): LayoutChildSettings {
  return {
    constraints: cloneConstraints(readNodeProperty(node, 'constraints') as Constraints | undefined),
    layoutAlign: readNodeProperty(node, 'layoutAlign'),
    layoutGrow: readNodeProperty(node, 'layoutGrow'),
    layoutPositioning: readNodeProperty(node, 'layoutPositioning'),
    layoutSizingHorizontal: readNodeProperty(node, 'layoutSizingHorizontal'),
    layoutSizingVertical: readNodeProperty(node, 'layoutSizingVertical'),
    minWidth: readNodeProperty(node, 'minWidth'),
    maxWidth: readNodeProperty(node, 'maxWidth'),
    minHeight: readNodeProperty(node, 'minHeight'),
    maxHeight: readNodeProperty(node, 'maxHeight'),
  };
}

function readNodeProperty(node: SceneNode, property: string): unknown {
  try {
    if (property in node) {
      return (node as SceneNode & Record<string, unknown>)[property];
    }
  } catch (_error) {
    return undefined;
  }

  return undefined;
}

function cloneConstraints(constraints: Constraints | undefined): Constraints | undefined {
  if (!constraints) return undefined;
  return { horizontal: constraints.horizontal, vertical: constraints.vertical };
}

function applyLayoutChildPositionSettings(node: SceneNode, settings: LayoutChildSettings) {
  setNodeProperty(node, 'constraints', settings.constraints);
  setNodeProperty(node, 'layoutAlign', settings.layoutAlign);
  setNodeProperty(node, 'layoutGrow', settings.layoutGrow);
  setNodeProperty(node, 'layoutPositioning', settings.layoutPositioning);
}

function applyLayoutChildSizeSettings(node: SceneNode, settings: LayoutChildSettings) {
  setNodeProperty(node, 'minWidth', settings.minWidth);
  setNodeProperty(node, 'maxWidth', settings.maxWidth);
  setNodeProperty(node, 'minHeight', settings.minHeight);
  setNodeProperty(node, 'maxHeight', settings.maxHeight);
  setNodeProperty(node, 'layoutSizingHorizontal', settings.layoutSizingHorizontal);
  setNodeProperty(node, 'layoutSizingVertical', settings.layoutSizingVertical);
}

function setNodeProperty(node: SceneNode, property: string, value: unknown): boolean {
  if (value === undefined) return false;

  try {
    (node as SceneNode & Record<string, unknown>)[property] = value;
    return true;
  } catch (_error) {
    return false;
  }
}

function isAutoLayoutContainer(node: BaseNode): boolean {
  try {
    return 'layoutMode' in node && (node as BaseNode & { layoutMode: string }).layoutMode !== 'NONE';
  } catch (_error) {
    return false;
  }
}

function getNodeDepth(node: BaseNode): number {
  let depth = 0;
  let parent = node.parent;

  while (parent && parent.type !== 'PAGE') {
    depth += 1;
    parent = parent.parent;
  }

  return depth;
}

function isRemoved(node: SceneNode): boolean {
  try {
    return node.removed;
  } catch (_error) {
    return true;
  }
}

function getAbsolutePositionedNodes(nodes: SceneNode[]): SceneNode[] {
  const absoluteNodes: SceneNode[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    try {
      if ('layoutPositioning' in node && node.layoutPositioning === 'ABSOLUTE' && !seen.has(node.id)) {
        seen.add(node.id);
        absoluteNodes.push(node);
      }
    } catch (_error) {
      continue;
    }
  }

  return absoluteNodes;
}

function createTextAnnotation(content: string): Annotation {
  return {
    labelMarkdown: content,
  };
}

function normalizeAnnotationsForSet(annotations: ReadonlyArray<Annotation>): Annotation[] {
  return annotations.map((annotation) => normalizeAnnotationForSet(annotation));
}

function normalizeAnnotationForSet(annotation: Annotation): Annotation {
  const normalized: { -readonly [K in keyof Annotation]?: Annotation[K] } = {};
  if (annotation.labelMarkdown) normalized.labelMarkdown = annotation.labelMarkdown;
  else if (annotation.label) normalized.label = annotation.label;
  if (annotation.categoryId) normalized.categoryId = annotation.categoryId;
  if (annotation.properties) normalized.properties = annotation.properties;
  return normalized as Annotation;
}

function buildAbsolutePositionAnnotationContent(node: SceneNode): string {
  return `${ABSOLUTE_POSITION_ANNOTATION}\n対象: ${getNodePath(node)}\nNode ID: ${node.id}`;
}

function buildAbsolutePositionSkipMessage(): string {
  return '絶対位置指定のあるノードが見つかったため、「グループをフレーム化」をスキップしました';
}

function safeRemove(node: SceneNode): boolean {
  try {
    node.remove();
    return true;
  } catch (error) {
    if (formatError(error).indexOf('does not exist') !== -1) return false;
    throw error;
  }
}

function cloneTransform(transform: Transform): Transform {
  return [
    [transform[0][0], transform[0][1], transform[0][2]],
    [transform[1][0], transform[1][1], transform[1][2]],
  ];
}

function invertTransform(transform: Transform): Transform {
  const a = transform[0][0];
  const c = transform[0][1];
  const e = transform[0][2];
  const b = transform[1][0];
  const d = transform[1][1];
  const f = transform[1][2];
  const determinant = a * d - b * c;

  if (Math.abs(determinant) < 0.000001) {
    return [
      [1, 0, 0],
      [0, 1, 0],
    ];
  }

  const inverseA = d / determinant;
  const inverseB = -b / determinant;
  const inverseC = -c / determinant;
  const inverseD = a / determinant;
  const inverseE = (c * f - d * e) / determinant;
  const inverseF = (b * e - a * f) / determinant;

  return [
    [inverseA, inverseC, inverseE],
    [inverseB, inverseD, inverseF],
  ];
}

function multiplyTransforms(left: Transform, right: Transform): Transform {
  const a1 = left[0][0];
  const c1 = left[0][1];
  const e1 = left[0][2];
  const b1 = left[1][0];
  const d1 = left[1][1];
  const f1 = left[1][2];
  const a2 = right[0][0];
  const c2 = right[0][1];
  const e2 = right[0][2];
  const b2 = right[1][0];
  const d2 = right[1][1];
  const f2 = right[1][2];

  return [
    [a1 * a2 + c1 * b2, a1 * c2 + c1 * d2, a1 * e2 + c1 * f2 + e1],
    [b1 * a2 + d1 * b2, b1 * c2 + d1 * d2, b1 * e2 + d1 * f2 + f1],
  ];
}

function transformsNearlyEqual(left: Transform, right: Transform): boolean {
  return Math.abs(left[0][0] - right[0][0]) <= 0.001
    && Math.abs(left[0][1] - right[0][1]) <= 0.001
    && Math.abs(left[0][2] - right[0][2]) <= 0.001
    && Math.abs(left[1][0] - right[1][0]) <= 0.001
    && Math.abs(left[1][1] - right[1][1]) <= 0.001
    && Math.abs(left[1][2] - right[1][2]) <= 0.001;
}

function setRelativeTransform(node: SceneNode, transform: Transform): boolean {
  try {
    (node as SceneNode & { relativeTransform: Transform }).relativeTransform = cloneTransform(transform);
    return true;
  } catch (_error) {
    return false;
  }
}

function isInsideInstance(node: BaseNode): boolean {
  let parent = node.parent;

  while (parent && parent.type !== 'PAGE') {
    if (parent.type === 'INSTANCE') return true;
    parent = parent.parent;
  }

  return false;
}

function hasAnnotations(node: SceneNode): node is AnnotatableSceneNode {
  return 'annotations' in node;
}

function buildNotifyMessage(stats: Stats): string {
  const parts = [
    `注釈 ${stats.annotations}`,
    `TextStyle ${stats.textStyles}`,
    `Frame化 ${stats.groups}`,
    `一覧 ${stats.tableRows}`,
    `絶対位置注釈 ${stats.absoluteAnnotations}`,
  ];

  if (stats.errors.length) {
    parts.push(`失敗 ${stats.errors.length}`);
  }
  if (stats.warnings.length) {
    parts.push(`スキップ ${stats.warnings.length}`);
  }

  return parts.join(' / ');
}

function getSafeName(node: SceneNode): string {
  try {
    return node.name;
  } catch (_error) {
    return 'Unknown node';
  }
}

async function collectAnnotationRows(targets: Array<{ artboardName: string; nodes: SceneNode[] }>): Promise<AnnotationRow[]> {
  const rows: AnnotationRow[] = [];
  const categoryNames = await getAnnotationCategoryNames();

  for (const target of targets) {
    for (const node of target.nodes) {
      try {
        if (node.removed || !hasAnnotations(node) || !node.annotations.length) continue;

        for (const annotation of node.annotations) {
          const linkTargetId = getLinkTargetId(node);
          rows.push({
            content: formatAnnotationContent(annotation),
            tag: formatAnnotationCategory(annotation, categoryNames),
            artboardName: target.artboardName || getNearestArtboardName(node),
            nodeId: node.id,
            linkTargetId,
            nodeUrl: buildNodeUrl(linkTargetId),
            sourceNode: node,
            markerAnnotationContent: null,
          });
        }
      } catch (_error) {
        continue;
      }
    }
  }

  return rows;
}

function collectAbsolutePositionAnnotationRows(absoluteNodes: SceneNode[]): AnnotationRow[] {
  return absoluteNodes.map((node) => {
    const content = buildAbsolutePositionAnnotationContent(node);
    const linkTargetId = getLinkTargetId(node);
    return {
      content,
      tag: '絶対位置',
      artboardName: getNearestArtboardName(node),
      nodeId: node.id,
      linkTargetId,
      nodeUrl: buildNodeUrl(linkTargetId),
      sourceNode: node,
      markerAnnotationContent: content,
    };
  });
}

async function getAnnotationCategoryNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();

  try {
    const categories = await figma.annotations.getAnnotationCategoriesAsync();
    for (const category of categories) {
      names.set(category.id, category.label);
    }
  } catch (_error) {
    return names;
  }

  return names;
}

function getNearestArtboardName(node: SceneNode): string {
  let parent = node.parent;

  while (parent && parent.type !== 'PAGE') {
    if (parent.type === 'FRAME') return getSafeName(parent);
    parent = parent.parent;
  }

  return '選択範囲';
}

function getNodePath(node: SceneNode): string {
  const names = [getSafeName(node)];
  let parent = node.parent;

  while (parent && parent.type !== 'PAGE') {
    if ('name' in parent) {
      names.unshift((parent as BaseNode & { name: string }).name);
    }
    parent = parent.parent;
  }

  return names.join(' / ');
}

function formatAnnotationContent(annotation: Annotation): string {
  if (annotation.labelMarkdown) return annotation.labelMarkdown.replace(/\s+/g, ' ').trim();
  if (annotation.label) return annotation.label;
  if (annotation.properties && annotation.properties.length) {
    return annotation.properties.map((property) => property.type).join(', ');
  }
  return '(タグなし)';
}

function formatAnnotationCategory(annotation: Annotation, categoryNames: Map<string, string>): string {
  if (annotation.categoryId && categoryNames.has(annotation.categoryId)) {
    const categoryName = categoryNames.get(annotation.categoryId);
    if (categoryName) return categoryName;
  }

  return '未分類';
}

async function createAnnotationTables(rows: AnnotationRow[], stats: Stats) {
  await figma.loadFontAsync(FONT_REGULAR);
  await figma.loadFontAsync(FONT_BOLD);
  removeAnnotationLinkMarkers();

  const groupedRows = groupRowsByArtboard(rows);
  const tables: FrameNode[] = [];
  let offsetY = 0;

  for (const group of groupedRows) {
    const table = createAnnotationTable(group.rows, stats, group.artboardName, offsetY);
    tables.push(table);
    offsetY += table.height + 80;
  }

  if (!groupedRows.length) {
    tables.push(createAnnotationTable([], stats, '選択範囲', 0));
  }

  figma.currentPage.selection = tables;
  figma.viewport.scrollAndZoomIntoView(tables);
}

function groupRowsByArtboard(rows: AnnotationRow[]): Array<{ artboardName: string; rows: AnnotationRow[] }> {
  const groups = new Map<string, { artboardName: string; rows: AnnotationRow[] }>();

  for (const row of rows) {
    let group = groups.get(row.artboardName);
    if (!group) {
      group = { artboardName: row.artboardName, rows: [] };
      groups.set(row.artboardName, group);
    }
    group.rows.push(row);
  }

  return Array.from(groups.values());
}

function createAnnotationTable(rows: AnnotationRow[], stats: Stats, artboardName: string, offsetY: number): FrameNode {
  const rowsWithMarkers = rows.map((row) => withMarkerLink(row, stats));

  const table = figma.createFrame();
  const minRowHeight = 40;
  const headerHeight = 44;
  const widths = [360, 120, 180, 112];
  const tableWidth = widths[0] + widths[1] + widths[2] + widths[3];

  table.name = `Annotation Table - ${artboardName}`;
  table.x = figma.viewport.center.x - tableWidth / 2;
  table.y = figma.viewport.center.y - headerHeight / 2 + offsetY;
  table.resizeWithoutConstraints(tableWidth, headerHeight);
  table.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  table.strokes = [{ type: 'SOLID', color: { r: 0.82, g: 0.82, b: 0.82 } }];
  table.strokeWeight = 1;
  table.clipsContent = false;

  createTableRow(table, 0, headerHeight, widths, ['内容', 'タグ', 'アートボード', 'リンク'], true, null, null);

  let totalHeight = headerHeight;
  if (!rowsWithMarkers.length) {
    const rowHeight = createTableRow(table, totalHeight, minRowHeight, widths, ['アノテーションなし', '未分類', '-', '-'], false, null, null);
    totalHeight += rowHeight;
  } else {
    rowsWithMarkers.forEach((row) => {
      if (!row.nodeUrl && stats.errors.indexOf('fileKeyを取得できないため、リンクURLを作成できませんでした') === -1) {
        stats.errors.push('fileKeyを取得できないため、リンクURLを作成できませんでした');
      }
      const rowHeight = createTableRow(table, totalHeight, minRowHeight, widths, [row.content, row.tag, row.artboardName, 'リンク先に飛ぶ'], false, row, stats);
      totalHeight += rowHeight;
    });
  }

  table.resizeWithoutConstraints(tableWidth, totalHeight);
  figma.currentPage.appendChild(table);
  return table;
}

function createTableRow(
  table: FrameNode,
  y: number,
  height: number,
  widths: number[],
  values: string[],
  isHeader: boolean,
  row: AnnotationRow | null,
  stats: Stats | null,
): number {
  let x = 0;
  const cells: FrameNode[] = [];
  const textNodes: TextNode[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const cell = figma.createFrame();
    cell.name = isHeader ? `Header ${values[index]}` : `Cell ${values[index]}`;
    cell.x = x;
    cell.y = y;
    cell.resizeWithoutConstraints(widths[index], height);
    cell.fills = [{ type: 'SOLID', color: isHeader ? { r: 0.94, g: 0.96, b: 1 } : { r: 1, g: 1, b: 1 } }];
    cell.strokes = [{ type: 'SOLID', color: { r: 0.86, g: 0.86, b: 0.86 } }];
    cell.strokeWeight = 1;
    cell.clipsContent = true;
    table.appendChild(cell);
    cells.push(cell);

    const text = figma.createText();
    text.name = values[index];
    text.fontName = isHeader ? FONT_BOLD : FONT_REGULAR;
    text.fontSize = 12;
    const hasLink = index === 3 && row !== null;
    text.fills = [{ type: 'SOLID', color: hasLink ? { r: 0, g: 0.37, b: 0.78 } : { r: 0.12, g: 0.12, b: 0.12 } }];
    text.characters = values[index];
    text.textAutoResize = 'HEIGHT';
    text.resize(Math.max(widths[index] - 24, 1), text.height);
    text.x = 12;
    text.y = isHeader ? height / 2 - 8 : 10;
    cell.appendChild(text);
    textNodes.push(text);
    if (hasLink) {
      const linkResult = setBestHyperlink(text, row);
      if (!linkResult.ok && stats) {
        stats.errors.push(`${row.artboardName}: ハイパーリンク挿入に失敗 (${linkResult.error})`);
      }
      text.textDecoration = 'UNDERLINE';
    }
    x += widths[index];
  }

  if (isHeader) return height;

  let measuredHeight = height;
  for (const text of textNodes) {
    measuredHeight = Math.max(measuredHeight, text.height + 20);
  }

  for (const cell of cells) {
    cell.resizeWithoutConstraints(cell.width, measuredHeight);
  }

  return measuredHeight;
}

function buildNodeUrl(nodeId: string): string | null {
  const fileKey = figma.fileKey || fallbackFileKey;
  if (!fileKey) return null;

  return `https://www.figma.com/design/${fileKey}/?node-id=${nodeId.replace(/:/g, '-')}`;
}

function withMarkerLink(row: AnnotationRow, stats: Stats): AnnotationRow {
  const marker = createAnnotationLinkMarker(row.sourceNode, stats);
  if (!marker) return row;

  if (row.markerAnnotationContent && setMarkerAnnotation(marker, row.markerAnnotationContent, row.artboardName, stats)) {
    stats.absoluteAnnotations += 1;
  }

  const linkTargetId = marker.id;
  return {
    content: row.content,
    tag: row.tag,
    artboardName: row.artboardName,
    nodeId: row.nodeId,
    linkTargetId,
    nodeUrl: buildNodeUrl(linkTargetId),
    sourceNode: row.sourceNode,
    markerAnnotationContent: row.markerAnnotationContent,
  };
}

function createAnnotationLinkMarker(node: SceneNode, stats: Stats): FrameNode | null {
  try {
    const box = node.absoluteBoundingBox;
    if (!box) return null;

    const marker = figma.createFrame();
    marker.name = 'Annotation Link Marker';
    marker.x = box.x;
    marker.y = box.y;
    marker.resizeWithoutConstraints(Math.max(box.width, 1), Math.max(box.height, 1));
    marker.fills = [];
    marker.strokes = [];
    marker.opacity = 1;
    marker.locked = false;
    marker.visible = true;
    marker.clipsContent = false;
    marker.setPluginData(MARKER_PLUGIN_KEY, MARKER_PLUGIN_VALUE);
    marker.setPluginData('source-node-id', node.id);
    figma.currentPage.appendChild(marker);
    return marker;
  } catch (_error) {
    stats.errors.push(`${getSafeName(node)}: 不可視マーカー作成に失敗`);
    return null;
  }
}

function setMarkerAnnotation(marker: FrameNode, content: string, artboardName: string, stats: Stats): boolean {
  try {
    marker.annotations = [createTextAnnotation(content)];
    return true;
  } catch (error) {
    stats.errors.push(`${artboardName}: マーカーへのアノテーション作成に失敗 (${formatError(error)})`);
    return false;
  }
}

function removeAnnotationLinkMarkers() {
  const markers: SceneNode[] = [];
  for (const node of figma.currentPage.children) {
    walkScene(node, (child) => {
      if (child.getPluginData(MARKER_PLUGIN_KEY) === MARKER_PLUGIN_VALUE) {
        markers.push(child);
      }
    });
  }

  for (const marker of markers) {
    try {
      marker.remove();
    } catch (_error) {
      continue;
    }
  }
}

function extractFileKey(url: string): string {
  if (!url) return '';
  const match = url.match(/figma\.com\/(?:file|design)\/([A-Za-z0-9]+)/);
  return match ? match[1] : '';
}

function getLinkTargetId(node: SceneNode): string {
  let current: BaseNode | null = node;
  let fallback = node.id;

  while (current && current.type !== 'PAGE') {
    if (current.type === 'INSTANCE') return current.id;
    if ('id' in current) fallback = current.id;
    current = current.parent;
  }

  return fallback;
}

function setBestHyperlink(text: TextNode, row: AnnotationRow): { ok: boolean; error: string } {
  if (row.nodeUrl) {
    const urlResult = setUrlHyperlink(text, row.nodeUrl);
    if (urlResult.ok) return urlResult;

    const nodeResult = setNodeHyperlink(text, row.linkTargetId);
    if (nodeResult.ok) return nodeResult;

    return { ok: false, error: `${urlResult.error} / ${nodeResult.error}` };
  }

  return setNodeHyperlink(text, row.linkTargetId);
}

function setUrlHyperlink(text: TextNode, url: string): { ok: boolean; error: string } {
  try {
    text.setRangeHyperlink(0, text.characters.length, { type: 'URL', value: url });
    return { ok: true, error: '' };
  } catch (error) {
    try {
      text.hyperlink = { type: 'URL', value: url };
      return { ok: true, error: '' };
    } catch (nestedError) {
      return { ok: false, error: formatError(nestedError || error) };
    }
  }
}

function setNodeHyperlink(text: TextNode, nodeId: string): { ok: boolean; error: string } {
  try {
    text.setRangeHyperlink(0, text.characters.length, { type: 'NODE', value: nodeId });
    return { ok: true, error: '' };
  } catch (error) {
    try {
      text.hyperlink = { type: 'NODE', value: nodeId };
      return { ok: true, error: '' };
    } catch (nestedError) {
      return { ok: false, error: formatError(nestedError || error) };
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
