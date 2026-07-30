export const PACKAGE_SCHEMA_VERSION = 1;

export type IssueSeverity = 'fatal' | 'blocker' | 'approvable' | 'warning';
export type IssueScope = 'package' | 'artboard' | 'node';

export type ApprovalAction =
  | 'DOWNSCALE_IMAGE'
  | 'RASTERIZE_SUBTREE'
  | 'OMIT_PROTOTYPE_FEATURE'
  | 'IMPORT_ACTIVE_COMPONENT_STATE'
  | 'APPROXIMATE_BACKGROUND_BLUR'
  | 'DETACH_REPEAT_GRID';

export interface MigrationIssue {
  id: string;
  scope: IssueScope;
  severity: IssueSeverity;
  code: string;
  message: string;
  artboardGuids: string[];
  nodeGuids: string[];
  allowedActions: ApprovalAction[];
  details?: Record<string, unknown>;
}

export interface ApprovalRecord {
  issueId: string;
  action: ApprovalAction;
  parameters: Record<string, unknown>;
  approver: { id?: string; name: string };
  approvedAt: string;
  packageHash: string;
  toolVersion: string;
}

export interface VisualReviewRecord {
  artboardGuid: string;
  referenceSha256: string | null;
  figmaSha256: string;
  ssim: number | null;
  diffPixelRate: number | null;
  dimensionsMatch: boolean | null;
  heatmapSha256?: string | null;
  approved: boolean;
  approver: { id?: string; name: string };
  approvedAt: string;
  packageHash: string;
}

export interface SourceFingerprint {
  algorithm: 'sha256';
  value: string;
  nodeCount: number;
  artboardCount: number;
}

export interface PackageManifest {
  schemaVersion: number;
  generatorVersion: string;
  createdAt: string;
  sourceFingerprint: SourceFingerprint;
  sourceXdVersion?: string;
  files: Record<string, { sha256: string; size: number }>;
  limits: PackageLimits;
}

export interface PackageLimits {
  archiveBytes: number;
  uncompressedBytes: number;
  assetBytes: number;
  artboards: number;
  nodes: number;
  uniqueAssets: number;
}

export interface XdAsset {
  assetId: string;
  path: string;
  sha256: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif';
  width: number;
  height: number;
  originalFileName: string | null;
  iccProfile: string | null;
  exif: Record<string, unknown> | null;
  usages: Array<{ nodeGuid: string; artboardGuid: string; imageTransform?: number[][] }>;
}

export interface FontAuditRecord {
  family: string;
  style: string;
  postscriptName: string | null;
  version: string | null;
  vendor: string | null;
  license: string | null;
  fsType: number | null;
  fileSha256: string | null;
  nodeGuids: string[];
}

export interface XdReferenceImage {
  artboardGuid: string;
  path: string;
  sha256: string;
}

export interface XdCoordinateRecord {
  guid: string;
  parentGuid: string | null;
  artboardGuid: string;
  zOrder: number;
  artboardX: number;
  artboardY: number;
}

export interface XdLayerBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface XdLayerRecord {
  guid: string;
  type: XdNodeType;
  name: string;
  parentGuid: string | null;
  artboardGuid: string;
  childGuids: string[];
  zOrder: number;
  depth: number;
  path: string[];
  localBounds: XdLayerBounds;
  artboardBounds: XdLayerBounds;
  contentBounds: XdLayerBounds | null;
}

export interface XdLayerDatabase {
  schemaVersion: 1;
  coordinateSpace: 'ARTBOARD_RELATIVE';
  records: XdLayerRecord[];
}

export type XdCoordinateSpace = 'XD_SCENEGRAPH_RAW_V1' | 'FIGMA_PARENT_LOCAL_FROM_ARTBOARD_V1';

export type XdNodeType =
  | 'ARTBOARD'
  | 'GROUP'
  | 'RECTANGLE'
  | 'ELLIPSE'
  | 'LINE'
  | 'POLYGON'
  | 'PATH'
  | 'BOOLEAN_GROUP'
  | 'TEXT'
  | 'SYMBOL_INSTANCE'
  | 'REPEAT_GRID'
  | 'SCROLLABLE_GROUP'
  | 'Lottie'
  | 'Video'
  | 'UNKNOWN';

export interface XdTextRange {
  length: number;
  fontFamily: string;
  fontStyle: string;
  fontSize: number;
  fill?: XdColor;
  charSpacing: number;
  lineSpacing?: number;
  underline: boolean;
  strikethrough: boolean;
  textTransform: 'none' | 'uppercase' | 'lowercase' | 'titlecase';
  textScript: 'none' | 'superscript' | 'subscript';
}

export interface XdColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface XdTextData {
  characters: string;
  styleRanges: XdTextRange[];
  layoutBox: 'POINT' | 'AREA' | 'AUTO_HEIGHT';
  textAlign: 'LEFT' | 'CENTER' | 'RIGHT';
  /** True only when XD intentionally clips overflowing Area Text. */
  clippedByArea?: boolean;
  width?: number;
  height?: number;
  /** Confirms that node x/y already represent the text frame's visual top-left. */
  positioningMode?: 'TOP_LEFT';
  /** XD point-text alignment anchor offset retained for coordinate auditing. */
  anchorOffsetX?: number;
  /** XD point-text first-line baseline offset retained for vertical placement. */
  anchorOffsetY?: number;
}

export interface XdNode {
  guid: string;
  type: XdNodeType;
  name: string;
  parentGuid: string | null;
  artboardGuid: string | null;
  children: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  visible: boolean;
  locked: boolean;
  opacity: number;
  fill?: XdColor;
  stroke?: XdColor;
  strokeWidth?: number;
  cornerRadius?: number;
  polygonPointCount?: number;
  blendMode?: string;
  /** XD layout/padding background role; rendered below regular siblings. */
  isBackground?: boolean;
  /** The container is an XD mask group. */
  maskGroup?: boolean;
  /** This node is the mask shape inside a mask group. */
  isMask?: boolean;
  clipContent?: boolean;
  /** XD clip shape bounds before its origin was rebased to the container. */
  clipPathBounds?: XdLayerBounds;
  viewportHeight?: number | null;
  fixedWhenScrolling?: boolean;
  sourcePathData?: string;
  pathData?: string;
  /** Source path bounds offset removed when pathData was normalized to (0, 0). */
  pathOffsetX?: number;
  pathOffsetY?: number;
  windingRule?: 'EVENODD' | 'NONZERO';
  text?: XdTextData;
  assetId?: string;
  layout?: {
    type: 'NONE' | 'RESPONSIVE' | 'PADDING' | 'STACK';
    orientation?: 'HORIZONTAL' | 'VERTICAL';
    spacing?: number | number[];
    padding?: { top: number; right: number; bottom: number; left: number };
  };
  unsupported?: string[];
}

export interface XdDocument {
  documentName: string;
  sourceFingerprint: SourceFingerprint;
  coordinateSpace?: XdCoordinateSpace;
  layerDatabaseVersion?: 1;
  nodes: XdNode[];
  artboardGuids: string[];
  fonts: FontAuditRecord[];
  assets: XdAsset[];
  references?: XdReferenceImage[];
  issues: MigrationIssue[];
}

export interface Xd2FigmaPackage {
  manifest: PackageManifest;
  document: XdDocument;
}
