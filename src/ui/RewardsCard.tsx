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
 * A single-column list card for rewards data.
 * Rendered when MarkdownText detects a :::rewards block.
 */
export default function RewardsCard({ data }: { data: RewardsData }): React.JSX.Element {
  const total = data.totalAstra ? Number(data.totalAstra) / 1_000_000_000 : 0;
  const epoch = data.epochAstra ? Number(data.epochAstra) / 1_000_000_000 : 0;
  const bonus = data.bonusAstra ? Number(data.bonusAstra) / 1_000_000_000 : 0;

  const statusColor = data.claimStatus === "claimable" ? "#00ff00"
    : data.claimStatus === "sent" ? "#00ffff"
    : "#ffff00";

  return (
    <Box flexDirection="column" paddingLeft={1} marginY={1}>
      <Box marginBottom={1}>
        <Text bold color="#ffff00">$ASTRA Rewards</Text>
        {data.seasonId && <Text dimColor>  {data.seasonId}</Text>}
      </Box>

      <Row label="Total Earned" value={formatAstra(total)} color="#ffff00" />
      <Row label="Epoch Rewards" value={formatAstra(epoch)} color="#00ffff" />
      <Row label="Season Bonus" value={formatAstra(bonus)} color="#ff00ff" />
      <Row label="Status" value={data.claimStatus ?? "—"} color={statusColor} />
      <Row label="Epochs Rewarded" value={data.epochsRewarded?.toString() ?? "—"} color="white" />

      {data.bestEpochPnl !== undefined && data.bestEpochPnl > 0 && (
        <Row label="Best Epoch P&L" value={`+${data.bestEpochPnl.toFixed(2)}`} color="#00ff00" />
      )}

      {data.txSignature && (
        <Box marginTop={1}>
          <Text dimColor>Tx: </Text>
          <Text color="#00ffff">{data.txSignature}</Text>
        </Box>
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
