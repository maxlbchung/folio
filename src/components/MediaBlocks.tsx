import type { AudioBlock, ImageBlock, VideoBlock } from "../document/types";
import { useDocument } from "../document/DocumentContext";

interface BaseProps {
  pageId: string;
  side: "front" | "back";
}

export function ImageBlockView({ block, pageId, side }: BaseProps & { block: ImageBlock }) {
  const { assets, updateBlock } = useDocument();
  const asset = assets[block.assetId];
  return (
    <div className="media-frame">
      {asset ? <img src={asset.url} alt={block.alt} style={{ objectFit: block.fit === "stretch" ? "fill" : block.fit }} /> : <MissingMedia />}
      <select className="media-fit" value={block.fit} onChange={(event) => updateBlock(pageId, side, block.id, { fit: event.target.value } as Partial<ImageBlock>, true)}>
        <option value="contain">Contain</option><option value="cover">Cover</option><option value="stretch">Stretch</option>
      </select>
    </div>
  );
}

export function VideoBlockView({ block, pageId, side }: BaseProps & { block: VideoBlock }) {
  const { assets, updateBlock } = useDocument();
  const asset = assets[block.assetId];
  return (
    <div className="media-frame">
      {asset ? <video src={asset.url} controls={block.controls} style={{ objectFit: block.fit }} /> : <MissingMedia />}
      <select className="media-fit" value={block.fit} onChange={(event) => updateBlock(pageId, side, block.id, { fit: event.target.value } as Partial<VideoBlock>, true)}>
        <option value="contain">Contain</option><option value="cover">Cover</option>
      </select>
    </div>
  );
}

export function AudioBlockView({ block }: BaseProps & { block: AudioBlock }) {
  const { assets } = useDocument();
  const asset = assets[block.assetId];
  return (
    <div className="audio-block">
      {asset ? <audio src={asset.url} controls /> : <MissingMedia />}
    </div>
  );
}

function MissingMedia() {
  return <div className="missing-media">Missing media</div>;
}
