import React from "react";
import { Box, Text } from "ink";

export interface PortfolioData {
  cash?: number;
  tokens?: number;
  currentPrice?: number;
  portfolioValue?: number;
  pnl?: number;
  pnlPct?: number;
  totalEarned?: string;
  claimable?: string;
  hasWallet?: boolean;
  walletLocal?: boolean;
}

/**
 * A styled two-column card for portfolio data.
 * Rendered when MarkdownText detects a :::portfolio block.
 */
export default function PortfolioCard({ data }: { data: PortfolioData }): React.JSX.Element {
  const price = data.currentPrice ?? 0;
  const cash = data.cash ?? 0;
  const tokens = data.tokens ?? 0;
  const value = data.portfolioValue ?? cash + tokens * price;
  const pnl = data.pnl ?? 0;
  const pnlPct = data.pnlPct ?? 0;

  // Convert lamports to ASTRA (9 decimals)
  const earned = data.totalEarned ? Number(data.totalEarned) / 1_000_000_000 : 0;
  const claimable = data.claimable ? Number(data.claimable) / 1_000_000_000 : 0;

  const pnlColor = pnl >= 0 ? "green" : "red";
  const pnlSign = pnl >= 0 ? "+" : "";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} marginY={1}>
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color="cyan">{"  Portfolio Overview  "}</Text>
      </Box>

      <Box flexDirection="row">
        {/* Left column */}
        <Box flexDirection="column" width="50%">
          <Row label="$SIM Balance" value={formatNum(cash)} color="cyan" />
          <Row label="$NOVA Holdings" value={tokens > 0 ? formatNum(tokens) : "—"} color="magenta" />
          <Row label="$NOVA Price" value={price > 0 ? formatPrice(price) : "—"} color="yellow" />
        </Box>

        {/* Right column */}
        <Box flexDirection="column" width="50%">
          <Row label="Portfolio Value" value={formatNum(value)} color="white" />
          <Row label="P&L" value={`${pnlSign}${formatNum(pnl)} (${pnlSign}${pnlPct.toFixed(1)}%)`} color={pnlColor} />
          {(data.hasWallet !== undefined || data.walletLocal !== undefined) && (
            <Row
              label="Wallet"
              value={data.hasWallet ? "registered" : data.walletLocal ? "needs registration" : "not set"}
              color={data.hasWallet ? "green" : data.walletLocal ? "yellow" : "gray"}
            />
          )}
        </Box>
      </Box>

      {/* Rewards section — only if there are any */}
      {(earned > 0 || claimable > 0) && (
        <>
          <Box marginTop={1} marginBottom={0}>
            <Text dimColor>{"─".repeat(36)}</Text>
          </Box>
          <Box flexDirection="row">
            <Box flexDirection="column" width="50%">
              <Row label="$ASTRA Earned" value={earned > 0 ? formatAstra(earned) : "—"} color="yellow" />
            </Box>
            <Box flexDirection="column" width="50%">
              <Row label="Claimable" value={claimable > 0 ? formatAstra(claimable) : "—"} color={claimable > 0 ? "green" : "gray"} />
            </Box>
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

function formatPrice(price: number): string {
  if (price >= 1) return `$${price.toFixed(2)}`;
  if (price >= 0.01) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(6)}`;
}

function formatNum(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatAstra(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M ASTRA`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K ASTRA`;
  return `${n.toFixed(2)} ASTRA`;
}
