import { PACKAGE_SCHEMA_VERSION, type MigrationIssue, type PackageLimits, type PackageManifest, type XdDocument } from './types';
import { sha256Hex, sha256HexSync, stableStringify } from './hash';

export const V1_LIMITS: PackageLimits = {
  archiveBytes: Math.floor(1.5 * 1024 * 1024 * 1024),
  uncompressedBytes: 2 * 1024 * 1024 * 1024,
  assetBytes: 1024 * 1024 * 1024,
  artboards: 500,
  nodes: 100_000,
  uniqueAssets: 5_000,
};

export function validateManifest(manifest: PackageManifest): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  if (manifest.schemaVersion !== PACKAGE_SCHEMA_VERSION) {
    issues.push(fatal('SCHEMA_UNSUPPORTED', `schemaVersion ${manifest.schemaVersion} は未対応です。`));
  }
  if (manifest.sourceFingerprint.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(manifest.sourceFingerprint.value)) {
    issues.push(fatal('INVALID_FINGERPRINT', 'source fingerprint が不正です。'));
  }
  return issues;
}

export function validateDocumentLimits(document: XdDocument, packageBytes: { archive: number; uncompressed: number; assets: number }): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  const overLimit = (
    actual: number,
    limit: number,
    label: string,
  ) => actual > limit && issues.push(fatal('PACKAGE_TOO_LARGE', `${label} がv1の上限を超えています。`, { actual, limit }));

  overLimit(packageBytes.archive, V1_LIMITS.archiveBytes, '圧縮パッケージサイズ');
  overLimit(packageBytes.uncompressed, V1_LIMITS.uncompressedBytes, '展開後サイズ');
  overLimit(packageBytes.assets, V1_LIMITS.assetBytes, '画像アセット総量');
  overLimit(document.artboardGuids.length, V1_LIMITS.artboards, 'アートボード数');
  overLimit(document.nodes.length, V1_LIMITS.nodes, 'ノード数');
  overLimit(document.assets.length, V1_LIMITS.uniqueAssets, 'ユニーク画像数');
  return issues;
}

export function collectArtboardIssues(document: XdDocument): MigrationIssue[] {
  const issues: MigrationIssue[] = [...document.issues];
  const nodesByGuid = new Map(document.nodes.map((node) => [node.guid, node]));

  for (const asset of document.assets) {
    if (asset.width > 4096 || asset.height > 4096) {
      issues.push({
        id: `image-size-${asset.assetId}`,
        scope: 'artboard',
        severity: 'approvable',
        code: 'IMAGE_DOWNSCALE_REQUIRED',
        message: `画像 ${asset.originalFileName ?? asset.assetId} はFigmaの4096px制限を超えています。`,
        artboardGuids: [...new Set(asset.usages.map((usage) => usage.artboardGuid))],
        nodeGuids: asset.usages.map((usage) => usage.nodeGuid),
        allowedActions: ['DOWNSCALE_IMAGE'],
        details: { width: asset.width, height: asset.height, sha256: asset.sha256 },
      });
    }
  }

  for (const node of document.nodes) {
    if (!node.artboardGuid) continue;
    if (node.type === 'Lottie' || node.type === 'Video') {
      issues.push({
        id: `media-adapter-${node.guid}`,
        scope: 'node', severity: 'blocker', code: 'MEDIA_RASTERIZATION_ADAPTER_REQUIRED',
        message: `${node.type} の静止画アダプターは未実装のため、このアートボードを除外します。`,
        artboardGuids: [node.artboardGuid], nodeGuids: [node.guid], allowedActions: [],
      });
    }
    if (node.layout?.type === 'STACK' && Array.isArray(node.layout.spacing)) {
      issues.push({
        id: `stack-spacing-${node.guid}`,
        scope: 'node',
        severity: 'warning',
        code: 'STACK_SPACING_FALLBACK',
        message: '不均一なStack間隔を絶対配置Frameへ変換します。',
        artboardGuids: [node.artboardGuid],
        nodeGuids: [node.guid],
        allowedActions: [],
      });
    }
    if (node.type === 'SYMBOL_INSTANCE') {
      issues.push(approvable(node, 'COMPONENT_STATE_PARTIAL', 'コンポーネントはアクティブ状態を通常Frameとして移植します。', ['IMPORT_ACTIVE_COMPONENT_STATE']));
    }
    if (node.type === 'REPEAT_GRID') {
      issues.push(approvable(node, 'REPEAT_GRID_DETACH_REQUIRED', 'Repeat Gridは通常Frameへデタッチして移植します。', ['DETACH_REPEAT_GRID']));
    }
    if (node.type === 'BOOLEAN_GROUP' && !node.pathData) {
      issues.push({
        id: `boolean-path-missing-${node.guid}`,
        scope: 'node', severity: 'blocker', code: 'BOOLEAN_PATH_MISSING',
        message: 'Boolean Groupの合成済みパスを取得できません。',
        artboardGuids: [node.artboardGuid], nodeGuids: [node.guid], allowedActions: [],
      });
    }
    for (const feature of node.unsupported ?? []) {
      issues.push(unsupportedIssue(node, feature));
    }
  }

  for (const font of document.fonts) {
    if (!font.family || !font.style) {
      const referencedNodes = font.nodeGuids.map((guid) => nodesByGuid.get(guid)).filter((node): node is NonNullable<typeof node> => Boolean(node));
      issues.push({
        id: `font-invalid-${font.family}-${font.style}`,
        scope: 'artboard',
        severity: 'blocker',
        code: 'FONT_NOT_AVAILABLE',
        message: 'フォントのfamily/style情報が不完全です。',
        artboardGuids: [...new Set(referencedNodes.map((node) => node.artboardGuid).filter((guid): guid is string => Boolean(guid)))],
        nodeGuids: font.nodeGuids,
        allowedActions: [],
      });
    }
  }

  return issues;
}

export async function fingerprintDocument(document: Pick<XdDocument, 'nodes' | 'artboardGuids'>): Promise<string> {
  const accumulator = createDocumentFingerprintAccumulator();
  for (const node of document.nodes) accumulator.addNode(node);
  return accumulator.finish(document.artboardGuids);
}

/**
 * Incremental, order-independent document fingerprinting for memory-constrained
 * plugin hosts. Only fixed-size node digests are retained; XdNode objects and a
 * whole-document canonical JSON string are never duplicated.
 */
export function createDocumentFingerprintAccumulator(): {
  addNode(node: XdDocument['nodes'][number]): void;
  finish(artboardGuids: string[]): Promise<string>;
  readonly nodeCount: number;
} {
  const nodeDigests: string[] = [];
  return {
    addNode(node): void {
      nodeDigests.push(sha256HexSync(stableStringify(node)));
    },
    async finish(artboardGuids): Promise<string> {
      const payload = {
        version: 2,
        artboardGuids: [...artboardGuids].sort(),
        nodeDigests: nodeDigests.sort(),
      };
      return sha256Hex(stableStringify(payload));
    },
    get nodeCount(): number { return nodeDigests.length; },
  };
}

export function fatal(code: string, message: string, details?: Record<string, unknown>): MigrationIssue {
  const suffix = sha256HexSync(`${code}:${message}:${stableStringify(details ?? {})}`).slice(0, 12);
  return { id: `${code.toLowerCase()}-${suffix}`, scope: 'package', severity: 'fatal', code, message, artboardGuids: [], nodeGuids: [], allowedActions: [], details };
}

function approvable(node: { guid: string; artboardGuid: string | null }, code: string, message: string, allowedActions: MigrationIssue['allowedActions']): MigrationIssue {
  return { id: `${code.toLowerCase()}-${node.guid}`, scope: 'node', severity: 'approvable', code, message, artboardGuids: node.artboardGuid ? [node.artboardGuid] : [], nodeGuids: [node.guid], allowedActions };
}

function unsupportedIssue(node: { guid: string; artboardGuid: string | null }, feature: string): MigrationIssue {
  const known = new Map<string, Pick<MigrationIssue, 'severity' | 'code' | 'message' | 'allowedActions'>>([
    ['THREE_D_TRANSFORM', { severity: 'approvable', code: 'THREE_D_RASTERIZE_REQUIRED', message: '3D変形はFigmaで直接表現できません。', allowedActions: ['RASTERIZE_SUBTREE'] }],
    ['BACKGROUND_BLUR_BRIGHTNESS', { severity: 'approvable', code: 'BACKGROUND_BLUR_APPROX_REQUIRED', message: '背景ぼかしの明度は近似またはラスタライズが必要です。', allowedActions: ['APPROXIMATE_BACKGROUND_BLUR', 'RASTERIZE_SUBTREE'] }],
    ['REPEAT_GRID_STRUCTURE', { severity: 'approvable', code: 'REPEAT_GRID_STRUCTURE_FALLBACK', message: 'Repeat Gridの構造差分はインスタンスoverrideにできません。', allowedActions: ['DETACH_REPEAT_GRID'] }],
    ['COMPONENT_STATE', { severity: 'approvable', code: 'COMPONENT_STATE_PARTIAL', message: '非表示のコンポーネントstateは完全移植できません。', allowedActions: ['IMPORT_ACTIVE_COMPONENT_STATE'] }],
    ['PROTOTYPE_FEATURE', { severity: 'approvable', code: 'PROTOTYPE_FEATURE_OMIT', message: 'このプロトタイプ機能はFigmaへ直接変換できません。', allowedActions: ['OMIT_PROTOTYPE_FEATURE'] }],
    ['GRADIENT_FILL', { severity: 'blocker', code: 'GRADIENT_FILL_UNSUPPORTED', message: 'このgradient fillはv1で損失なく変換できません。', allowedActions: [] }],
    ['EFFECTS', { severity: 'blocker', code: 'EFFECTS_UNSUPPORTED', message: 'このshadow/blur効果はv1で損失なく変換できません。', allowedActions: [] }],
    ['MASK', { severity: 'blocker', code: 'MASK_UNSUPPORTED', message: 'このmaskはv1で損失なく変換できません。', allowedActions: [] }],
    ['BLEND_MODE', { severity: 'blocker', code: 'BLEND_MODE_UNSUPPORTED', message: 'このblend modeはv1で損失なく変換できません。', allowedActions: [] }],
  ]);
  const mapped = known.get(feature);
  if (mapped) return { id: `${mapped.code.toLowerCase()}-${node.guid}`, scope: 'node', artboardGuids: node.artboardGuid ? [node.artboardGuid] : [], nodeGuids: [node.guid], ...mapped };
  return { id: `unsupported-${node.guid}-${feature}`, scope: 'node', severity: 'blocker', code: 'UNSUPPORTED_XD_FEATURE', message: `未対応のXD機能: ${feature}`, artboardGuids: node.artboardGuid ? [node.artboardGuid] : [], nodeGuids: [node.guid], allowedActions: [] };
}
