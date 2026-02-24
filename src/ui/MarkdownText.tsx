import React from "react";
import { Text, Box } from "ink";
import PortfolioCard from "./PortfolioCard.js";
import type { PortfolioData } from "./PortfolioCard.js";
import RewardsCard from "./RewardsCard.js";
import type { RewardsData } from "./RewardsCard.js";

interface MarkdownTextProps {
  children: string;
}

/**
 * Render a markdown string with basic formatting in Ink.
 *
 * Supports:
 * - **bold** and __bold__
 * - *italic* and _italic_
 * - `inline code`
 * - ```code blocks```
 * - - bullet lists
 * - 1. numbered lists
 * - ## headers (any level)
 * - --- horizontal rules
 */
export default function MarkdownText({ children }: MarkdownTextProps): React.JSX.Element {
  const lines = children.split("\n");
  const elements: React.JSX.Element[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Rich card blocks: :::portfolio or :::rewards
    if (line.trimStart().startsWith(":::portfolio") || line.trimStart().startsWith(":::rewards")) {
      const cardType = line.trimStart().startsWith(":::portfolio") ? "portfolio" : "rewards";
      const jsonLines: string[] = [];
      i++; // skip opening :::
      while (i < lines.length && !lines[i]!.trimStart().startsWith(":::")) {
        jsonLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing :::
      try {
        const raw = jsonLines.join("\n");
        if (cardType === "portfolio") {
          const data = JSON.parse(raw) as PortfolioData;
          elements.push(<PortfolioCard key={elements.length} data={data} />);
        } else {
          const data = JSON.parse(raw) as RewardsData;
          elements.push(<RewardsCard key={elements.length} data={data} />);
        }
      } catch {
        elements.push(
          <Box key={elements.length}>
            <Text wrap="wrap">{jsonLines.join("\n")}</Text>
          </Box>,
        );
      }
      continue;
    }

    // Code block: ``` ... ```
    if (line.trimStart().startsWith("```")) {
      const codeLines: string[] = [];
      i++; // skip opening ```
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <Box key={elements.length} marginLeft={2} marginY={0}>
          <Text color="gray">{codeLines.join("\n")}</Text>
        </Box>,
      );
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      elements.push(
        <Box key={elements.length}>
          <Text dimColor>{"─".repeat(40)}</Text>
        </Box>,
      );
      i++;
      continue;
    }

    // Header: # ## ### etc
    const headerMatch = /^(#{1,4})\s+(.+)$/.exec(line);
    if (headerMatch) {
      elements.push(
        <Box key={elements.length} marginTop={elements.length > 0 ? 1 : 0}>
          <Text bold color="cyan">{headerMatch[2]}</Text>
        </Box>,
      );
      i++;
      continue;
    }

    // Bullet list: - item or * item
    const bulletMatch = /^(\s*)[-*]\s+(.+)$/.exec(line);
    if (bulletMatch) {
      const indent = Math.floor((bulletMatch[1]?.length ?? 0) / 2);
      elements.push(
        <Box key={elements.length} marginLeft={indent * 2}>
          <Text>{"  ● "}</Text>
          {renderInline(bulletMatch[2]!)}
        </Box>,
      );
      i++;
      continue;
    }

    // Numbered list: 1. item
    const numMatch = /^(\s*)(\d+)[.)]\s+(.+)$/.exec(line);
    if (numMatch) {
      const indent = Math.floor((numMatch[1]?.length ?? 0) / 2);
      elements.push(
        <Box key={elements.length} marginLeft={indent * 2}>
          <Text>{"  "}{numMatch[2]}. </Text>
          {renderInline(numMatch[3]!)}
        </Box>,
      );
      i++;
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      elements.push(<Box key={elements.length}><Text> </Text></Box>);
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(
      <Box key={elements.length} flexWrap="wrap">
        {renderInline(line)}
      </Box>,
    );
    i++;
  }

  return <Box flexDirection="column">{elements}</Box>;
}

/**
 * Parse inline markdown (**bold**, *italic*, `code`) and return
 * an array of <Text> elements with appropriate styling.
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
        node: <Text key={key++} bold>{boldMatch[1] ?? boldMatch[2]}</Text>,
      });
    }

    // `inline code`
    const codeMatch = /`([^`]+?)`/.exec(remaining);
    if (codeMatch) {
      candidates.push({
        index: codeMatch.index,
        length: codeMatch[0].length,
        node: <Text key={key++} color="yellow">{codeMatch[1]}</Text>,
      });
    }

    // *italic* or _italic_ (not inside ** or __)
    const italicMatch = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/.exec(remaining);
    if (italicMatch) {
      candidates.push({
        index: italicMatch.index,
        length: italicMatch[0].length,
        node: <Text key={key++} italic>{italicMatch[1] ?? italicMatch[2]}</Text>,
      });
    }

    // Pick the earliest match
    candidates.sort((a, b) => a.index - b.index);
    const pick = candidates[0];

    if (!pick) {
      parts.push(<Text key={key++}>{remaining}</Text>);
      break;
    }

    // Text before the match
    if (pick.index > 0) {
      parts.push(<Text key={key++}>{remaining.slice(0, pick.index)}</Text>);
    }

    parts.push(pick.node);
    remaining = remaining.slice(pick.index + pick.length);
  }

  return <Text wrap="wrap">{parts}</Text>;
}
