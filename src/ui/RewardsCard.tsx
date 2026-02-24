import React from "react";
import { Box, Text } from "ink";

export interface RewardsData {
  seasonId?: string;
  totalAstra?: string;
  epochAstra?: string;
  bonusAstra?: string;
  epochsRewarded?: number;
  bestEpochPnl?: number;
  claimStatus?: string;
  txSignature?: string | null;
}

/**
 * A styled card for rewards data.
 * Rendered when MarkdownText detects a :::rewards block.
 */
export default function RewardsCard({ data }: { data: RewardsData }): React.JSX.Element {
  const total = data.totalAstra ? Number(data.totalAstra) / 1_000_000_000 : 0;
  const epoch = data.epochAstra ? Number(data.epochAstra) / 1_000_000_000 : 0;
  const bonus = data.bonusAstra ? Number(data.bonusAstra) / 1_000_000_000 : 0;

  const statusColor = data.claimStatus === "claimable" ? "green"
    : data.claimStatus === "sent" ? "cyan"
    : "yellow";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={2} paddingY={1} marginY={1}>
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color="yellow">{"  $ASTRA Rewards  "}</Text>
        {data.seasonId && <Text dimColor> — {data.seasonId}</Text>}
      </Box>

      <Box flexDirection="row">
        <Box flexDirection="column" width="50%">
          <Row label="Total Earned" value={formatAstra(total)} color="yellow" />
          <Row label="Epoch Rewards" value={formatAstra(epoch)} color="cyan" />
          <Row label="Season Bonus" value={formatAstra(bonus)} color="magenta" />
        </Box>

        <Box flexDirection="column" width="50%">
          <Row label="Status" value={data.claimStatus ?? "—"} color={statusColor} />
          <Row label="Epochs Rewarded" value={data.epochsRewarded?.toString() ?? "—"} color="white" />
          {data.bestEpochPnl !== undefined && data.bestEpochPnl > 0 && (
            <Row label="Best Epoch P&L" value={`+${data.bestEpochPnl.toFixed(2)}`} color="green" />
          )}
        </Box>
      </Box>

      {data.txSignature && (
        <>
          <Box marginTop={1}>
            <Text dimColor>{"─".repeat(36)}</Text>
          </Box>
          <Box>
            <Text dimColor>Tx: </Text>
            <Text color="cyan">{data.txSignature}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}

function Row({ label, value, color }: { label: string; value: string; color: string }): React.JSX.Element {
  return (
    <Box>
      <Text dimColor>{label}: </Text>
      <Text color={color} bold>{value}</Text>
    </Box>
  );
}

function formatAstra(n: number): string {
  if (n === 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M ASTRA`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K ASTRA`;
  return `${n.toFixed(4)} ASTRA`;
}
