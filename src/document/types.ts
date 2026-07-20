export type PageSide = "front" | "back";
export type PageType = "standard" | "drawing";
export type MediaFit = "contain" | "cover" | "stretch";
export type VerticalAlignment = "top" | "center" | "bottom";

export interface InktileDocument {
  format: "com.inktile.document";
  formatVersion: 1;
  id: string;
  title: string;
  createdAt: string;
  modifiedAt: string;
  settings: {
    pageWidth: number;
    contentPadding: number;
  };
  pageOrder: string[];
  pageRows: string[][];
  pages: Record<string, InktilePage>;
  assets: Record<string, AssetMetadata>;
}

export interface InktilePage {
  id: string;
  type: PageType;
  front: PageFace;
  back?: PageFace;
  activeSide: PageSide;
  verticalAlign: VerticalAlignment;
  layoutHeight?: number;
  layoutWidthFraction?: number;
  drawing?: DrawingBlock;
}

export interface PageFace {
  blocks: Block[];
}

export type Block =
  | TextBlock
  | ImageBlock
  | VideoBlock
  | AudioBlock
  | VariantGroupBlock
  | DrawingBlock
  | DividerBlock;

export interface BlockBase {
  id: string;
  type: Block["type"];
}

export interface TextBlock {
  id: string;
  type: "text";
  html: string;
}

export interface ImageBlock {
  id: string;
  type: "image";
  assetId: string;
  /** Legacy: seeds a media page's `layoutHeight` during normalization; sizing now follows the page. */
  height: number;
  fit: MediaFit;
  alt: string;
}

export interface VideoBlock {
  id: string;
  type: "video";
  assetId: string;
  /** Legacy: seeds a media page's `layoutHeight` during normalization; sizing now follows the page. */
  height: number;
  fit: Exclude<MediaFit, "stretch">;
  controls: boolean;
}

export interface AudioBlock {
  id: string;
  type: "audio";
  assetId: string;
  size: "compact" | "standard";
}

export interface VariantGroupBlock {
  id: string;
  type: "variants";
  activeVariant: number;
  variants: Variant[];
}

export interface Variant {
  id: string;
  label: string;
  html: string;
}

export interface DrawingBlock {
  id: string;
  type: "drawing";
  height: number;
  strokes: DrawingStroke[];
}

export interface DrawingStroke {
  id: string;
  tool: "pen" | "highlighter" | "eraser";
  width: number;
  opacity: number;
  points: DrawingPoint[];
}

export interface DrawingPoint {
  x: number;
  y: number;
  pressure?: number;
}

export interface DividerBlock {
  id: string;
  type: "divider";
}

export interface AssetMetadata {
  id: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  hash: string;
  internalPath: string;
}

export interface RuntimeAsset {
  metadata: AssetMetadata;
  blob: Blob;
  url: string;
}

export type RuntimeAssetMap = Record<string, RuntimeAsset>;
