import type { ReactNode } from "react";

/**
 * Small dependency-free markdown renderer for Inkjet's narration bubbles.
 * Builds React elements (never raw HTML), so model output cannot inject
 * markup. Covers the chat subset: paragraphs with line breaks, headings,
 * bullet/numbered lists, blockquotes, fenced and inline code, bold, italic,
 * links, and horizontal rules. Unclosed markers render literally, which keeps
 * partially streamed text readable until the closing marker arrives.
 */

const INLINE_PATTERN = /(`[^`\n]+`)|(\*\*[^*\n](?:[^\n]*?[^*\n])?\*\*)|(\*[^*\s\n](?:[^*\n]*?[^*\s\n])?\*)|(_[^_\s\n](?:[^_\n]*?[^_\s\n])?_)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/;

const renderInline = (text: string, keyPrefix: string): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let rest = text;
  let index = 0;
  while (rest.length > 0) {
    const match = INLINE_PATTERN.exec(rest);
    if (!match || match.index === undefined) {
      nodes.push(rest);
      break;
    }
    if (match.index > 0) nodes.push(rest.slice(0, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    } else {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      nodes.push(<a key={key} href={href} target="_blank" rel="noopener noreferrer" title={href}>{renderInline(label, key)}</a>);
    }
    rest = rest.slice(match.index + token.length);
    index += 1;
  }
  return nodes;
};

const renderLines = (lines: string[], keyPrefix: string): ReactNode[] =>
  lines.flatMap((line, index) => {
    const content = renderInline(line, `${keyPrefix}-${index}`);
    return index < lines.length - 1 ? [...content, <br key={`${keyPrefix}-br-${index}`} />] : content;
  });

interface Block {
  kind: "paragraph" | "heading" | "bullets" | "numbers" | "quote" | "code" | "rule";
  lines: string[];
  level?: number;
}

const parseBlocks = (text: string): Block[] => {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let index = 0;
  const isBullet = (line: string) => /^\s*[-*•]\s+/.test(line);
  const isNumber = (line: string) => /^\s*\d+[.)]\s+/.test(line);

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.trimStart().startsWith("```")) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith("```")) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", lines: body });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", lines: [heading[2]], level: heading[1].length });
      index += 1;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ kind: "rule", lines: [] });
      index += 1;
      continue;
    }
    if (isBullet(line) || isNumber(line)) {
      const ordered = isNumber(line);
      const items: string[] = [];
      while (index < lines.length && (ordered ? isNumber(lines[index]) : isBullet(lines[index]))) {
        items.push(lines[index].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/, ""));
        index += 1;
      }
      blocks.push({ kind: ordered ? "numbers" : "bullets", lines: items });
      continue;
    }
    if (line.trimStart().startsWith(">")) {
      const body: string[] = [];
      while (index < lines.length && lines[index].trimStart().startsWith(">")) {
        body.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", lines: body });
      continue;
    }
    const body: string[] = [];
    while (
      index < lines.length && lines[index].trim() &&
      !lines[index].trimStart().startsWith("```") && !/^(#{1,6})\s+/.test(lines[index]) &&
      !isBullet(lines[index]) && !isNumber(lines[index]) && !lines[index].trimStart().startsWith(">")
    ) {
      body.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: "paragraph", lines: body });
  }
  return blocks;
};

export function InkjetMarkdown({ text }: { text: string }) {
  return (
    <div className="inkjet-md">
      {parseBlocks(text).map((block, index) => {
        const key = `b-${index}`;
        switch (block.kind) {
          case "code":
            return <pre key={key}><code>{block.lines.join("\n")}</code></pre>;
          case "heading":
            return <p key={key} className={`inkjet-md__heading inkjet-md__heading--${Math.min(block.level ?? 3, 3)}`}>{renderInline(block.lines[0], key)}</p>;
          case "rule":
            return <hr key={key} />;
          case "bullets":
            return <ul key={key}>{block.lines.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>)}</ul>;
          case "numbers":
            return <ol key={key}>{block.lines.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>)}</ol>;
          case "quote":
            return <blockquote key={key}>{renderLines(block.lines, key)}</blockquote>;
          default:
            return <p key={key}>{renderLines(block.lines, key)}</p>;
        }
      })}
    </div>
  );
}
