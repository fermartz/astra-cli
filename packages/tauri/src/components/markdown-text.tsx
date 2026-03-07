import React, { useMemo } from "react";

interface MarkdownTextProps {
  children: string;
}

/**
 * Render a markdown string with basic formatting for the web.
 *
 * Ported from the CLI's Ink-based MarkdownText component.
 * Supports: **bold**, *italic*, `code`, ```code blocks```,
 * headers, bullet/numbered lists, horizontal rules.
 */
export default function MarkdownText({ children }: MarkdownTextProps): React.JSX.Element {
  const elements = useMemo(() => {
    const lines = children.split("\n");
    const result: React.JSX.Element[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i]!;

      // Code block: ``` ... ```
      if (line.trimStart().startsWith("```")) {
        const codeLines: string[] = [];
        i++; // skip opening ```
        while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) {
          codeLines.push(lines[i]!);
          i++;
        }
        // If we hit end-of-input without closing ```, block is still streaming — show raw
        if (i >= lines.length) {
          result.push(
            <div key={result.length} className="text-muted-foreground">
              {"```"}
              {codeLines.length > 0 && "\n" + codeLines.join("\n")}
            </div>,
          );
          break;
        }
        i++; // skip closing ```
        result.push(
          <pre
            key={result.length}
            className="bg-muted rounded-md p-3 text-xs font-mono overflow-x-auto my-1"
          >
            {codeLines.join("\n")}
          </pre>,
        );
        continue;
      }

      // Horizontal rule
      if (/^---+$/.test(line.trim())) {
        result.push(
          <hr key={result.length} className="border-border my-2" />,
        );
        i++;
        continue;
      }

      // Header: # ## ### etc
      const headerMatch = /^(#{1,4})\s+(.+)$/.exec(line);
      if (headerMatch) {
        const level = headerMatch[1]!.length;
        const sizes = ["text-lg", "text-base", "text-sm", "text-sm"];
        result.push(
          <div
            key={result.length}
            className={`font-semibold text-primary ${sizes[level - 1]} ${result.length > 0 ? "mt-2" : ""}`}
          >
            {renderInline(headerMatch[2]!)}
          </div>,
        );
        i++;
        continue;
      }

      // Bullet list: - item or * item
      const bulletMatch = /^(\s*)[-*]\s+(.+)$/.exec(line);
      if (bulletMatch) {
        const indent = Math.floor((bulletMatch[1]?.length ?? 0) / 2);
        result.push(
          <div key={result.length} className="flex" style={{ paddingLeft: `${indent * 16}px` }}>
            <span className="mr-2 text-muted-foreground">•</span>
            <span>{renderInline(bulletMatch[2]!)}</span>
          </div>,
        );
        i++;
        continue;
      }

      // Numbered list: 1. item
      const numMatch = /^(\s*)(\d+)[.)]\s+(.+)$/.exec(line);
      if (numMatch) {
        const indent = Math.floor((numMatch[1]?.length ?? 0) / 2);
        result.push(
          <div key={result.length} className="flex" style={{ paddingLeft: `${indent * 16}px` }}>
            <span className="mr-2 text-muted-foreground">{numMatch[2]}.</span>
            <span>{renderInline(numMatch[3]!)}</span>
          </div>,
        );
        i++;
        continue;
      }

      // Empty line
      if (line.trim() === "") {
        result.push(<div key={result.length} className="h-2" />);
        i++;
        continue;
      }

      // Regular paragraph
      result.push(
        <div key={result.length}>
          {renderInline(line)}
        </div>,
      );
      i++;
    }

    return result;
  }, [children]);

  return <div className="flex flex-col">{elements}</div>;
}

/**
 * Parse inline markdown (**bold**, *italic*, `code`) and return
 * an array of <span> elements with appropriate styling.
 */
interface InlineMatch {
  index: number;
  length: number;
  node: React.ReactNode;
}

function renderInline(text: string): React.JSX.Element {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    const candidates: InlineMatch[] = [];

    // **bold** or __bold__
    const boldMatch = /\*\*(.+?)\*\*|__(.+?)__/.exec(remaining);
    if (boldMatch) {
      candidates.push({
        index: boldMatch.index,
        length: boldMatch[0].length,
        node: <span key={key++} className="font-bold">{boldMatch[1] ?? boldMatch[2]}</span>,
      });
    }

    // `inline code`
    const codeMatch = /`([^`]+?)`/.exec(remaining);
    if (codeMatch) {
      candidates.push({
        index: codeMatch.index,
        length: codeMatch[0].length,
        node: (
          <code key={key++} className="bg-muted px-1 py-0.5 rounded text-xs font-mono">
            {codeMatch[1]}
          </code>
        ),
      });
    }

    // *italic* or _italic_ (not inside ** or __)
    const italicMatch = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/.exec(remaining);
    if (italicMatch) {
      candidates.push({
        index: italicMatch.index,
        length: italicMatch[0].length,
        node: <span key={key++} className="italic">{italicMatch[1] ?? italicMatch[2]}</span>,
      });
    }

    // Pick the earliest match
    candidates.sort((a, b) => a.index - b.index);
    const pick = candidates[0];

    if (!pick) {
      parts.push(<span key={key++}>{remaining}</span>);
      break;
    }

    // Text before the match
    if (pick.index > 0) {
      parts.push(<span key={key++}>{remaining.slice(0, pick.index)}</span>);
    }

    parts.push(pick.node);
    remaining = remaining.slice(pick.index + pick.length);
  }

  return <span>{parts}</span>;
}
