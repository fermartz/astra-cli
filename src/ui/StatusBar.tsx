import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text } from "ink";
import { apiCall } from "../utils/http.js";
import type { JourneyStage } from "../agent/system-prompt.js";
import type { AutopilotMode } from "../autopilot/scheduler.js";
import type { PluginMap } from "../domain/loader.js";
import { formatInterval } from "../autopilot/scheduler.js";

interface StatusBarProps {
  agentName: string;
  pluginName: string;
  /** Whether this is AstraNova — enables market/portfolio polling and $NOVA/$SIM display. */
  isAstraNova: boolean;
  journeyStage: JourneyStage;
  autopilotMode?: AutopilotMode;
  autopilotIntervalMs?: number;
  onEpochChange?: (epochId: number) => void;
  pluginMap?: PluginMap | null;
}

interface MarketState {
  price: number;
  mood: string;
  epochId: number;
}

interface Portfolio {
  cash: number;
  tokens: number;
  portfolioValue: number;
  pnl: number;
  pnlPct: number;
}

interface BarData {
  market: MarketState | null;
  portfolio: Portfolio | null;
}

const POLL_INTERVAL_MS = 60_000; // 60 seconds

const StatusBar = React.memo(function StatusBar({
  agentName,
  pluginName,
  isAstraNova,
  journeyStage,
  autopilotMode = "off",
  autopilotIntervalMs = 300_000,
  onEpochChange,
  pluginMap,
}: StatusBarProps): React.JSX.Element {
  // Single state object to batch market + portfolio updates into one render
  const [data, setData] = useState<BarData>({ market: null, portfolio: null });
  const mounted = useRef(true);
  // Market/portfolio data only makes sense for AstraNova (journey stages, $SIM/$NOVA)
  const canFetchData = isAstraNova && journeyStage !== "fresh" && journeyStage !== "pending";

  // Generic plugin status polling (non-AstraNova only)
  const [pluginData, setPluginData] = useState<Record<string, unknown> | null>(null);
  const mountedPlugin = useRef(true); // separate ref — never shared with AstraNova effect

  useEffect(() => {
    if (isAstraNova || !pluginMap?.status) return;
    mountedPlugin.current = true;

    const fetchPlugin = async () => {
      const result = await apiCall("GET", pluginMap.status!.poll, undefined, agentName);
      if (!result.ok || !mountedPlugin.current) return;
      setPluginData(result.data as Record<string, unknown>);
    };

    void fetchPlugin();
    const pollInterval = pluginMap?.status?.intervalMs ?? POLL_INTERVAL_MS;
    const interval = setInterval(() => void fetchPlugin(), pollInterval);
    return () => {
      mountedPlugin.current = false;
      clearInterval(interval);
    };
  }, [isAstraNova, pluginMap, agentName]);

  const poll = useCallback(async () => {
    const [marketRes, portfolioRes] = await Promise.all([
      fetchMarket(agentName),
      fetchPortfolio(agentName),
    ]);
    if (!mounted.current) return;
    setData((prev) => ({
      market: marketRes ?? prev.market,
      portfolio: portfolioRes ?? prev.portfolio,
    }));
    if (marketRes && onEpochChange) {
      onEpochChange(marketRes.epochId);
    }
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

  const apActive = autopilotMode !== "off";

  return (
    <Box flexDirection="column" width="100%">
      <Box paddingX={1} justifyContent="space-between">
        <Box>
        <Text bold color="#00ff00">
          {pluginName}
        </Text>
        <Text dimColor> │ </Text>
        <Text color="#ff8800">{agentName}</Text>

        {!isAstraNova && pluginData && pluginMap?.status?.fields.map((field) => {
          const value = getNestedValue(pluginData, field.path);
          if (value == null) return null;
          return (
            <React.Fragment key={field.path}>
              <Text dimColor> │ </Text>
              <Text color={field.color}>{field.label}: {String(value)}</Text>
            </React.Fragment>
          );
        })}

        {!isAstraNova && !pluginData && pluginMap?.status && (
          <>
            <Text dimColor> │ </Text>
            <Text dimColor>loading...</Text>
          </>
        )}

        {canFetchData && market && (
          <>
            <Text dimColor> │ </Text>
            <Text color="#ffff00">$NOVA </Text>
            <Text color="white">{formatPrice(market.price)}</Text>
            <Text dimColor> │ </Text>
            <Text color={moodColor(market.mood)}>{market.mood}</Text>
          </>
        )}

        {canFetchData && portfolio && (
          <>
            <Text dimColor> │ </Text>
            <Text color="#00ffff">{formatNum(portfolio.cash)} $SIM</Text>
            {portfolio.tokens > 0 && (
              <>
                <Text dimColor> │ </Text>
                <Text color="#ff00ff">{formatNum(portfolio.tokens)} $NOVA</Text>
              </>
            )}
            {portfolio.pnl !== 0 && (
              <>
                <Text dimColor> │ </Text>
                <Text color={portfolio.pnl >= 0 ? "#00ff00" : "#ff4444"}>
                  P&L {portfolio.pnl >= 0 ? "+" : ""}{formatNum(portfolio.pnl)} ({portfolio.pnlPct >= 0 ? "+" : ""}{portfolio.pnlPct.toFixed(1)}%)
                </Text>
              </>
            )}
            <Text dimColor> │ </Text>
            <Text color="#e2f902">Net {formatNum(portfolio.portfolioValue)}</Text>
          </>
        )}

        {isAstraNova && !canFetchData && (
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

        {apActive && (
          <Text color="#00ff00">AP: ● {autopilotMode.toUpperCase()} {formatInterval(autopilotIntervalMs)}</Text>
        )}
      </Box>
    </Box>
  );
});

export default StatusBar;

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
      return "#00ff00";
    case "fear":
    case "bearish":
      return "#ff4444";
    case "crab":
      return "#ffff00";
    default:
      return "white";
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────

function getNestedValue(obj: unknown, path: string): unknown {
  return path.split(".").reduce(
    (cur, key) =>
      cur && typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined,
    obj,
  );
}

// ─── API Fetchers ──────────────────────────────────────────────────────

interface MarketApiResponse {
  market?: {
    price?: number;
    mood?: string;
    epoch?: { global?: number; [key: string]: unknown };
    [key: string]: unknown;
  };
  price?: number;
  mood?: string;
  epoch?: { global?: number; [key: string]: unknown };
  [key: string]: unknown;
}

async function fetchMarket(agentName: string): Promise<MarketState | null> {
  const result = await apiCall<MarketApiResponse>("GET", "/api/v1/market/state", undefined, agentName);
  if (!result.ok) return null;

  const d = result.data;
  // Handle nested (d.market.price) or flat (d.price) response
  const m = d.market ?? d;
  return {
    price: m.price ?? 0,
    mood: m.mood ?? "",
    epochId: (m.epoch as { global?: number } | undefined)?.global ?? 0,
  };
}

interface PortfolioApiResponse {
  portfolio?: {
    cash?: number;
    tokens?: number;
    portfolioValue?: number;
    currentPrice?: number;
    pnl?: number;
    pnlPct?: number;
    [key: string]: unknown;
  };
  cash?: number;
  tokens?: number;
  portfolioValue?: number;
  currentPrice?: number;
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
  // Handle nested (d.portfolio.cash) or flat (d.cash) response
  const p = d.portfolio ?? d;
  const cash = p.cash ?? 0;
  const tokens = p.tokens ?? 0;
  const currentPrice = p.currentPrice ?? 0;
  return {
    cash,
    tokens,
    portfolioValue: p.portfolioValue ?? cash + tokens * currentPrice,
    pnl: p.pnl ?? 0,
    pnlPct: p.pnlPct ?? 0,
  };
}
