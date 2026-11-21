export interface AimRule {
  to: string;
  from: [number, number];
  min: number;
  max: number;
}

export interface PieceSpec {
  i: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  src: string;
  visible?: boolean;
  scaleX?: number;
  scaleY?: number;
  swivelStretch?: boolean;
  maskThreshold?: number;
}

export interface RigNodeSpec {
  id: string;
  name: string;
  parent: string | null;
  pivot: [number, number];
  aim: AimRule | null;
  top?: number;
  left?: number;
  ang?: number;
  limits?: [number, number];
  lock?: boolean;
  ghost?: boolean;
  flipX?: boolean;
  bar?: string[] | null;
  pieces: PieceSpec[];
}

export type ComponentModelKey = 'bytruvyus' | 'gotz' | 'yorick' | 'piggy';

export interface RigSpec {
  name?: string;
  source?: string;
  component?: ComponentModelKey | 'master';
  W: number;
  H: number;
  nodes: RigNodeSpec[];
}

export type AssembledModelsMap = Partial<Record<ComponentModelKey, RigSpec>>;

export interface BitruvianDocument {
  rig: RigSpec;
  parts?: Record<string, unknown>;
}

export interface RuntimePiece extends PieceSpec {
  i0: number;
  node: RuntimeNode;
  bm?: HTMLImageElement | HTMLCanvasElement | ImageBitmap;
  mask?: Uint8Array;
  mw?: number;
  mh?: number;
  st?: number;
}

export interface RuntimeNode {
  id: string;
  name: string;
  parent: string | null;
  aim: AimRule | null;
  pieces: RuntimePiece[];
  piv: [number, number];
  rest: [number, number];
  ang: number;
  tx: number;
  ty: number;
  w: Float64Array;
  eff: number;
  bond: RuntimeNode | null;
  lock: boolean;
  ghost: boolean;
  flipX: boolean;
  bar: string[] | null;
  at: [number, number] | null;
  limits: [number, number];
}

export interface HydratedRig {
  W: number;
  H: number;
  nodes: RuntimeNode[];
  by: Record<string, RuntimeNode>;
  root: RuntimeNode;
  pieces: RuntimePiece[];
}

export interface BondStrainInfo {
  nodeId: string;
  side: string;
  delta: number;
  strained: boolean;
}

export type StageMode = 'design-anchors' | 'place-pieces' | 'pose-test';
export type AppTab = 'studio' | 'dreams-parser' | 'rig-tree' | 'export';

export type AnchorConvention =
  | 'auto'
  | 'normalized-tl'
  | 'normalized-center'
  | 'layer-offset'
  | 'stage-world';

export interface TuningConfig {
  anchorConvention: AnchorConvention;
  scaleFactor: number;
  offsetX: number;
  offsetY: number;
  reverseZ: boolean;
}

export interface DreamsTableInfo {
  name: string;
  columns: string[];
  rowCount: number;
  sampleRows: Record<string, unknown>[];
}

export interface ExtractedAsset {
  id: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  src: string;
  byteSize: number;
  origin: 'sqlite-blob' | 'zip-entry' | 'uploaded-file' | 'valkyrie-carve' | 'procreate-chunk' | 'procedural';
  stageBox?: { x: number; y: number; w: number; h: number };
}

export interface DeducedTrackRule {
  trackId: string;
  rawName: string;
  component: ComponentModelKey;
  suggestedNodeId: string;
  parentTrackId: string | null;
  suggestedParentId: string | null;
  rawAnchor: [number, number] | null;
  anchorSpace: string;
  layerBox: { x: number; y: number; w: number; h: number };
  computedPivot: [number, number];
  restAngle: number;
  limits: [number, number];
  locked: boolean;
  aimTargetId: string | null;
  aimMin: number;
  aimMax: number;
  zIndex: number;
  matchedAssetId: string | null;
  inferenceReason: string;
}

export interface ValkyrieBlockSummary {
  index: number;
  offset: number;
  size: number;
  headerHex: string;
  detectedSignatures: string[];
}

export interface ValkyrieDiagnostics {
  isValkyrie: boolean;
  totalBytes: number;
  blockCount: number;
  blockStride: number;
  carvedSqliteCount: number;
  carvedPlistCount: number;
  carvedJsonCount: number;
  carvedZlibCount: number;
  carvedLz4Count: number;
  carvedImageCount: number;
  blocks: ValkyrieBlockSummary[];
  recoveredStrings: string[];
  decodedPlists: Array<{ offset: number; summary: unknown }>;
}

export interface IdenticalPartMatch {
  sourceAssetId: string;
  sourceName: string;
  matchedAssetId: string;
  matchedName: string;
  matchKind: 'exact-bytes' | 'mirrored-twin' | 'dimension-twin' | 'canonical-prior';
  confidence: number;
  suggestedComponent?: ComponentModelKey;
  suggestedRole?: string;
}

export interface DreamsInspectionReport {
  fileName: string;
  fileSize: number;
  containerType: 'valkyrie-drm' | 'sqlite' | 'zip-package' | 'procreate' | 'json-rig' | 'asset-stack';
  stageWidth: number;
  stageHeight: number;
  tables: DreamsTableInfo[];
  assets: ExtractedAsset[];
  tracks: DeducedTrackRule[];
  assembledModels: AssembledModelsMap;
  partMatches?: IdenticalPartMatch[];
  conventionUsed: AnchorConvention;
  tuning: TuningConfig;
  valkyrie?: ValkyrieDiagnostics;
  notes: string[];
}
