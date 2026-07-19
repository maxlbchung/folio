import type { Block, PageSide } from "../document/types";
import { useDocument } from "../document/DocumentContext";
import { TextBlockView } from "./TextBlockView";
import { AudioBlockView, ImageBlockView, VideoBlockView } from "./MediaBlocks";
import { VariantBlockView } from "./VariantBlockView";
import { DrawingCanvas } from "./DrawingCanvas";

interface Props {
  pageId: string;
  side: PageSide;
  block: Block;
}

export function BlockRenderer({ pageId, side, block }: Props) {
  const { updateBlock, convertVariantToText, checkpoint } = useDocument();

  return (
    <div className={`block-shell block-shell--${block.type}`}>
      {block.type === "text" && <TextBlockView block={block} onStartChange={checkpoint} onChange={(html, record) => updateBlock(pageId, side, block.id, { html }, record)} />}
      {block.type === "image" && <ImageBlockView block={block} pageId={pageId} side={side} />}
      {block.type === "video" && <VideoBlockView block={block} pageId={pageId} side={side} />}
      {block.type === "audio" && <AudioBlockView block={block} pageId={pageId} side={side} />}
      {block.type === "variants" && <VariantBlockView block={block} onConvertToText={() => convertVariantToText(pageId, side, block.id)} onStartChange={checkpoint} onChange={(next, record) => updateBlock(pageId, side, block.id, next, record)} />}
      {block.type === "drawing" && <DrawingCanvas block={block} onChange={(next, record) => updateBlock(pageId, side, block.id, next, record)} />}
      {block.type === "divider" && <hr className="content-divider" />}
    </div>
  );
}
