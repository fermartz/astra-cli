import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text } from "ink";
import { apiCall } from "../utils/http.js";
import type { JourneyStage } from "../agent/system-prompt.js";
import type { AutopilotMode } from "../autopilot/scheduler.js";
import { formatInterval, EPOCH_BUDGET } from "../autopilot/scheduler.js";

interface TopBarProps {
  agentName: string;
  journeyStage: JourneyStage;
  autopilotMode: AutopilotMode;
  autopilotIntervalMs: number;
  epochCallCount: number;
  onEpochChange?: (newEpoch: number) => void;
}

interface MarketState {
  price: number;
  mood: string;
  globalEpoch?: number;
  seasonIndex?: number;
}

interface Portfolio {
  cash: number;
  tokens: number;
  pnl: number;
  pnlPct: number;
}

interface BarData {
  market: MarketState | null;
  portfolio: Portfolio | null;
}

const POLL_INTERVAL_MS = 30_000;

const TopBar = React.memo(function TopBar({
  agentName,
  journeyStage,
  autopilotMode,
  autopilotIntervalMs,
  epochCallCount,
  onEpochChange,
}: TopBarProps): React.JSX.Element {
  const [data, setData] = useState<BarData>({ market: null, portfolio: null });
  const mounted = useRef(true);
  const lastEpochRef = useRef<number | null>(null);
  const canFetchData = journeyStage !== "fresh" && journeyStage !== "pending";

  const poll = useCallback(async () => {
    const [marketRes, portfolioRes] = await Promise.all([
      fetchMarket(agentName),
      fetchPortfolio(agentName),
    ]);
    if (!mounted.current) return;

    // Detect epoch changes
    if (marketRes?.globalEpoch !== undefined && onEpochChange) {
      if (lastEpochRef.current !== null && marketRes.globalEpoch !== lastEpochRef.current) {
        onEpochChange(marketRes.globalEpoch);
      }
      lastEpochRef.current = marketRes.globalEpoch;
    }

    setData((prev) => ({
      market: marketRes ?? prev.market,
      portfolio: portfolioRes ?? prev.portfolio,
    }));
  }, [agentName, onEpochChange]);

  useEffect(() => {
    mounted.current = true;
    if (!canFetchData) return;
    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      clearInterval(interval);
    };
  }, [canFetchData, poll]);

  const { market, portfolio } = data;

  // Autopilot status string
  const apStatus = buildApStatus(autopilotMode, autopilotIntervalMs, epochCallCount);

  return (
    <Box flexDirection="column" width="100%" borderStyle="single" borderColor="gray" paddingX={1}>
      {/* Row 1: Agent / Season / Price / Mood / Balance */}
      <Box>
        <Text bold color="green">ASTRA</Text>
        <Text dimColor> │ </Text>
        <Text color="white">{agentName}</Text>

        {canFetchData && market && (
          <>
            {market.seasonIndex !== undefined && (
              <>
                <Text dimColor> │ </Text>
                <Text color="white">S{String(market.seasonIndex).padStart(4, "0")}</Text>
                {market.globalEpoch !== undefined && (
                  <Text dimColor>·E{String(market.globalEpoch).padStart(3, "0")}</Text>
                )}
              </>
            )}
            <Text dimColor> │ </Text>
            <Text color="yellow">${formatPrice(market.price)}</Text>
            <Text dimColor> </Text>
            <Text color={moodColor(market.mood)}>{market.mood}</Text>
          </>
        )}

        {canFetchData && portfolio && (
          <>
            <Text dimColor> │ </Text>
            <Text color="cyan">$SIM:{formatNum(portfolio.cash)}</Text>
            {portfolio.tokens > 0 && (
              <>
                <Text dimColor> │ </Text>
                <Text color="magenta">{formatNum(portfolio.tokens)} $NOVA</Text>
              </>
            )}
          </>
        )}

        {!canFetchData && (
          <>
            <Text dimColor> │ </Text>
            <Text dimColor>pending verification</Text>
          </>
        )}

        {canFetchData && !market && !portfolio && (
          <>
            <Text dimColor> │ </Text>
            <Text dimColor>loading...</Text>
          </>
        )}
      </Box>

      {/* Row 2: Autopilot status (right-aligned) */}
      <Box justifyContent="flex-end">
        {apStatus}
      </Box>
    </Box>
  );
});

export default TopBar;

// ─── Autopilot Status Builder ─────────────────────────────────────────

function buildApStatus(
  mode: AutopilotMode,
  intervalMs: number,
  epochCallCount: number,
): React.JSX.Element {
  if (mode === "off") {
    return <Text dimColor>AP: ○ OFF</Text>;
  }

  const label = mode.toUpperCase();
  const interval = formatInterval(intervalMs);
  const budgetUsed = epochCallCount;
  const isPaused = budgetUsed >= EPOCH_BUDGET;
  const isLow = budgetUsed >= EPOCH_BUDGET - 1;

  let budgetColor: string = "white";
  if (isPaused) budgetColor = "red";
  else if (isLow) budgetColor = "yellow";

  return (
    <Box>
      <Text color="green">AP: ● {label} {interval}</Text>
      <Text> </Text>
      <Text color={budgetColor}>
        [{budgetUsed}/{EPOCH_BUDGET}{isPaused ? " PAUSED" : ""}]
      </Text>
    </Box>
  );
}

// ─── Formatting ────────────────────────────────────────────────────────

function formatPrice(price: number): string {
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(6);
}

function formatNum(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function moodColor(mood: string): string {
  switch (mood) {
    case "euphoria":
    case "bullish":
      return "green";
    case "fear":
    case "bearish":
      return "red";
    case "crab":
      return "yellow";
    default:
      return "white";
  }
}

// ─── API Fetchers ──────────────────────────────────────────────────────

interface MarketApiResponse {
  market?: {
    price?: number;
    mood?: string;
    globalEpoch?: number;
    seasonIndex?: number;
    [key: string]: unknown;
  };
  price?: number;
  mood?: string;
  globalEpoch?: number;
  seasonIndex?: number;
  [key: string]: unknown;
}

async function fetchMarket(agentName: string): Promise<MarketState | null> {
  const result = await apiCall<MarketApiResponse>("GET", "/api/v1/market/state", undefined, agentName);
  if (!result.ok) return null;

  const d = result.data;
  const m = d.market ?? d;
  return {
    price: m.price ?? 0,
    mood: m.mood ?? "",
    globalEpoch: m.globalEpoch,
    seasonIndex: m.seasonIndex,
  };
}

interface PortfolioApiResponse {
  portfolio?: {
    cash?: number;
    tokens?: number;
    pnl?: number;
    pnlPct?: number;
    [key: string]: unknown;
  };
  cash?: number;
  tokens?: number;
  pnl?: number;
  pnlPct?: number;
  [key: string]: unknown;
}

async function fetchPortfolio(agentName: string): Promise<Portfolio | null> {
  const result = await apiCall<PortfolioApiResponse>(
    "GET",
    "/api/v1/portfolio",
    undefined,
    agentName,
  );
  if (!result.ok) return null;

  const d = result.data;
  const p = d.portfolio ?? d;
  return {
    cash: p.cash ?? 0,
    tokens: p.tokens ?? 0,
    pnl: p.pnl ?? 0,
    pnlPct: p.pnlPct ?? 0,
  };
}
