import type { MarketData, PortfolioData } from "@/lib/protocol";

interface StatusBarProps {
  market: MarketData | null;
  portfolio: PortfolioData | null;
  activeToolName: string | null;
  status: string;
  pluginName: string | null;
  agentName: string | null;
}

export function StatusBar({ market, portfolio, activeToolName, status, pluginName, agentName }: StatusBarProps) {
  const activityText = activeToolName
    ? `Running: ${activeToolName}...`
    : status === "streaming"
      ? "Thinking..."
      : status === "ready"
        ? "Ready"
        : status === "connecting"
          ? "Connecting..."
          : "Disconnected";

  const hasData = market || portfolio;

  return (
    <div className="border-t border-border bg-muted">
      {/* Status row */}
      <div className="flex items-center justify-between px-4 py-2.5 text-xs text-muted-foreground">
        {/* Left: plugin + agent + market + portfolio */}
        <div className="flex items-center gap-0 min-w-0 overflow-hidden">
          {pluginName && (
            <span className="text-green-400 font-medium">{pluginName}</span>
          )}

          {agentName && (
            <>
              <Pipe />
              <span className="text-orange-400">{agentName}</span>
            </>
          )}

          {market && (
            <>
              <Pipe />
              <span>
                <span className="text-yellow-400">$NOVA</span>{" "}
                <span className="text-foreground">{formatPrice(market.price)}</span>
              </span>
              <Pipe />
              <span className={moodColor(market.mood)}>{market.mood}</span>
            </>
          )}

          {portfolio && (
            <>
              <Pipe />
              <span className="text-cyan-400">{formatNum(portfolio.cash)} $SIM</span>
              {portfolio.tokens > 0 && (
                <>
                  <Pipe />
                  <span className="text-fuchsia-400">{formatNum(portfolio.tokens)} $NOVA</span>
                </>
              )}
              {portfolio.pnl !== 0 && (
                <>
                  <Pipe />
                  <span className={portfolio.pnl >= 0 ? "text-green-400" : "text-red-400"}>
                    P&L {portfolio.pnl >= 0 ? "+" : ""}{formatNum(portfolio.pnl)} ({portfolio.pnlPct >= 0 ? "+" : ""}{portfolio.pnlPct.toFixed(1)}%)
                  </span>
                </>
              )}
              <Pipe />
              <span className="text-lime-400">Net {formatNum(portfolio.portfolioValue)}</span>
            </>
          )}

          {!hasData && !pluginName && <span>loading...</span>}
          {!hasData && pluginName && (
            <>
              <Pipe />
              <span>loading...</span>
            </>
          )}
        </div>

        {/* Right: activity indicator */}
        <span className="shrink-0 ml-3">{activityText}</span>
      </div>

      {/* Command hints */}
      <div className="flex items-center justify-between px-4 pb-1.5 text-[11px] text-muted-foreground/50">
        <span>/help · /portfolio · /market · /buy · /sell</span>
        <span>/strategy · /auto on·off·set · /model · /clear</span>
      </div>
    </div>
  );
}

function Pipe() {
  return <span className="text-muted-foreground/40 mx-2">│</span>;
}

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
      return "text-green-400";
    case "fear":
    case "bearish":
      return "text-red-400";
    case "crab":
      return "text-yellow-400";
    default:
      return "text-muted-foreground";
  }
}
