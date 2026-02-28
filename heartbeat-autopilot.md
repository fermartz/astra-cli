# Plan: New TUI Layout + Semi/Full Autopilot

## Context

The current astra-cli TUI is a single-column chat interface. This plan redesigns
it into a dashboard-style layout with a static top bar, split chat/log screen, and
footer — and adds two autopilot trading modes (semi and full) that let the agent
act on the market without the user having to initiate every action.

All trades are $SIM only. No real money at stake. The on-chain reward claiming
flow is unchanged and remains fully manual (future feature).

---

## Gate 1 — Codebase Exploration

**Current layout (App.tsx):**
```
Box flexDirection="column" height="100%"
  ChatView          (flexGrow:1)
  Spinner           (conditional)
  Input             (flexShrink:0)
  StatusBar         (flexShrink:0)  ← polls /market/state + /portfolio every 30s
  Footer help text  (flexShrink:0)
```

**Key facts:**
- `useStdoutDimensions` NOT used anywhere today — must be added
- `StatusBar.tsx` owns the 30s market/portfolio polling via `useEffect + setInterval`
- `sendMessage()` in App.tsx is the sole entry point for all LLM turns
- `isLoading` boolean blocks user input during turns
- Two message arrays: `coreMessages[]` (LLM history) + `chatMessages[]` (display)
- `runAgentTurn()` in loop.ts is fully decoupled from UI — callable from any context
- StatusBar pattern (useEffect + setInterval + cleanup) is the established interval pattern
- No existing autopilot/scheduler code anywhere

---

## Gate 2 — Risk Analysis

| Risk | Mitigation |
|------|-----------|
| Autopilot fires while a user turn is already running | Check `isLoadingRef.current` before firing; skip tick if busy (no queue — next interval catches it) |
| Two autopilot timers stacking on mode change | `useEffect` dep on `[autopilotMode, autopilotIntervalMs]` returns cleanup that clears old interval |
| Context bloat from many autopilot turns | Compaction already triggers automatically in `runAgentTurn()` — no new handling needed |
| Autopilot log growing unbounded in memory | Cap `autopilotLogEntries` at 100 entries |
| Terminal too small for split layout | `useStdoutDimensions()` check at App root — render resize screen below 100×28 |
| StatusBar and TopBar both polling simultaneously | StatusBar is removed; TopBar inherits its polling logic entirely |
| Semi-autopilot fires while user is mid-type | Semi uses `sendMessage()` — `isLoading` check prevents concurrent turns |
| Full autopilot response polluting chatMessages | Full adds to `autopilotLogEntries` only; chat gets one brief notification line |
| `isLoading` stale closure in timer callback | Use `isLoadingRef` (ref mirror of state) — timer reads ref, not closure |
| **API rate limit: max 10 calls per epoch (~30min)** | **Epoch call counter — see section below** |

---

## Gate 3 — Security Analysis

- **No new credential/key surface.** Autopilot only calls `api_call` → POST `/api/v1/trades` — already sandboxed. No wallet signing in autopilot.
- **Trigger message is hardcoded.** Not LLM-generated, not user-supplied. No injection vector.
- **`memory.md` / remote doc influence.** Could nudge LLM strategy. Acceptable — trades are $SIM only.
- **Config storage.** `autopilot.mode` + `autopilot.intervalMs` written to `config.json` via existing `writeFileSecure()`. Non-sensitive.
- **No on-chain actions in autopilot scope.** `sign_and_send_transaction` is never called. Reward claiming stays manual.

---

## Gate 4 — Simplicity Check

**NOT building in this plan:**
- Daemon mode (`astra --daemon`) — separate future feature
- Rule-based strategy engine — LLM decides via system prompt
- Multiple named strategies — one strategy guided by memory.md
- Autopilot for reward claiming — explicitly deferred

**Minimal change set:** 3 new files, 5 modified files.

---

## New Layout

```
┌──────────────────────────────────────────────────────────────────┐
│ ASTRA │ phantom-drift │ S0001·E042 │ $0.047 ▲ bull │ $SIM:10,432 │  row 1
│                                                   │ AP: ● SEMI 5m│  row 2
├───────────────────────────────────┬──────────────────────────────┤
│                                   │  AUTOPILOT LOG               │
│  CHAT              (flexGrow)     │  ─────────────────────────   │
│                                   │  14:23 checked → hold        │
│  Agent: NOVA is looking bearish   │  14:18 bought 200 NOVA       │
│                                   │        @ $0.048 momentum     │
│  You: what's my balance?          │  14:13 no signal → skip      │
│                                   │                              │
│  Agent: 10,432 SIM + 847 NOVA     │  (hidden when AP: OFF)       │
├───────────────────────────────────┴──────────────────────────────┤
│  > _                                                             │
├──────────────────────────────────────────────────────────────────┤
│  /portfolio /market /rewards /trades /board    /auto on·off·set  │
└──────────────────────────────────────────────────────────────────┘
```

**Rules:**
- Minimum: **100 cols × 28 rows** — show resize screen below this
- Log panel: **38 cols wide**, fixed. Hidden when `autopilotMode === "off"` (chat gets full width)
- TopBar: 2 rows. Left = agent/season/epoch. Right = price/mood/balance/AP status
- Footer: 1 row. Left = existing commands. Right = `/auto` hints

---

## Semi vs Full Autopilot

### Semi
- Timer fires every N minutes (default 5min)
- Injects hardcoded trigger into chat via `sendMessage()`:
  `"AUTOPILOT CHECK: Analyze market and propose a trade if signal is clear. Ask me to confirm before executing."`
- LLM responds in chat: "NOVA up 3% — I'd buy 200. Approve? (y/n)"
- User types y → LLM executes on next turn
- Log panel: shows each check + outcome

### Full
- Timer fires every N minutes (default 5min)
- Calls `runAutopilotTurn()` (NOT `sendMessage()`)
- Trigger added to `coreMessages` only (not chatMessages)
- LLM executes trade via tools; response → `autopilotLogEntries`
- Chat gets one brief line: `"🤖 Autopilot: bought 200 NOVA @ $0.047"`
- If no action: log entry only, no chat notification

---

## New Slash Commands

| Command | Behavior |
|---------|----------|
| `/auto on` | Enable semi mode |
| `/auto semi` | Enable semi mode |
| `/auto full` | Enable full mode |
| `/auto off` | Disable |
| `/auto 5m` / `10m` / `15m` / `30m` | Set interval |
| `/auto status` | Show mode + interval + last action time |

All handled locally in `sendMessage()` — no LLM turn needed.

---

## Files

### New

| File | Purpose |
|------|---------|
| `src/ui/TopBar.tsx` | Static 2-row header. Owns 30s market/portfolio polling (moved from StatusBar). Shows agent, season, epoch, price, mood, balance, AP status. |
| `src/ui/AutopilotLog.tsx` | Right panel. Props: `entries: AutopilotLogEntry[]`, `width: number`. Scrollable, newest at bottom. Each entry: timestamp + action + dim detail. |
| `src/autopilot/scheduler.ts` | `AutopilotMode`, `AutopilotConfig` types. `SEMI_TRIGGER_MSG` / `FULL_TRIGGER_MSG` hardcoded strings. `buildAutopilotTrigger(mode)`. Pure logic, no React. |

### Modified

**`src/ui/App.tsx`**
- Add `useStdoutDimensions()` — resize guard at root
- Replace StatusBar with TopBar
- New state: `autopilotMode`, `autopilotIntervalMs`, `autopilotLogEntries`
- `isLoadingRef` mirror for timer safety
- `useEffect` autopilot timer (cleans up on mode/interval change)
- `runAutopilotTurn()` internal fn for full mode
- SplitView: `<Box flexDirection="row">` with ChatView (flexGrow) + AutopilotLog (conditional)
- `/auto` slash command handling
- New prop: `initialAutopilotConfig?: AutopilotConfig`

**`src/agent/system-prompt.ts`**
- Add `autopilotMode` to `AgentProfile`
- Add autopilot section after agent state block:
  ```
  ## AUTOPILOT: {mode} (every {N}min)
  On AUTOPILOT CHECK triggers:
  - GET /api/v1/market/state + GET /api/v1/portfolio
  - Apply strategy from memory.md (default: momentum + balance)
  - SEMI: propose trade, wait for explicit user approval
  - FULL: execute if signal clear; skip if uncertain
  - Max 2-3 lines. No action = "Market checked — holding."
  ```

**`src/config/schema.ts`**
- Add to ConfigSchema:
  ```typescript
  autopilot: z.object({
    mode: z.enum(["off", "semi", "full"]).default("off"),
    intervalMs: z.number().min(60000).max(3600000).default(300000),
  }).default({ mode: "off", intervalMs: 300000 }),
  ```

**`src/config/store.ts`**
- `loadAutopilotConfig()` — thin wrapper over `loadConfig().autopilot`
- `saveAutopilotConfig(cfg)` — thin wrapper over `saveConfig({...existing, autopilot: cfg})`

**`src/bin/astra.ts`**
- Load autopilot config after `loadConfig()`
- Pass `initialAutopilotConfig` to App

---

## API Rate Limit: Epoch Call Budget

The Agent API enforces a max of **10 calls per epoch** (~30 min). Autopilot must
respect this or it will hit 429 errors and log confusing failures.

### How it works

Each autopilot turn makes ~2-3 API calls:
- 1× GET `/api/v1/market/state`
- 1× GET `/api/v1/portfolio`
- 1× POST `/api/v1/trades` (if a trade fires)

At 5min intervals, that's up to 6 autopilot checks per 30min epoch = up to 18 calls.
**Way over budget.** The counter prevents this.

### Counter design

```typescript
// In App.tsx (or scheduler.ts)
const epochCallCountRef = useRef(0);
const epochIdRef = useRef<number | null>(null);

// TopBar already polls /api/v1/market/state every 30s.
// Expose the current globalEpoch from its data to App.tsx.
// When globalEpoch changes → reset epochCallCountRef to 0.

// Before each autopilot turn:
const CALLS_PER_AUTOPILOT_TURN = 3; // market + portfolio + potential trade
const EPOCH_BUDGET = 10;
const BUFFER = 2; // reserve 2 calls for user-initiated actions

if (epochCallCountRef.current + CALLS_PER_AUTOPILOT_TURN > EPOCH_BUDGET - BUFFER) {
  addLogEntry("Budget reached for this epoch — skipping until next epoch");
  return;
}
epochCallCountRef.current += CALLS_PER_AUTOPILOT_TURN;
```

### Epoch boundary detection

TopBar already fetches `GET /api/v1/market/state` every 30s and reads `globalEpoch`.
- Add `onEpochChange` callback prop to TopBar: `(newEpoch: number) => void`
- App.tsx passes a handler that resets `epochCallCountRef.current = 0`
- This is the cleanest signal — no need for a separate timer

### Log panel shows budget

Add to TopBar AP status: `AP: ● SEMI 5m [6/10]` — calls used this epoch.
When budget is low: `AP: ● SEMI 5m [9/10]` in yellow.
When exhausted: `AP: ● SEMI 5m [10/10 PAUSED]` in red.

### What counts toward the budget

Only autopilot-initiated turns count. User-initiated turns do NOT decrement the
autopilot budget (they have their own rate limit considerations at the API level).
The counter is local — it tracks what autopilot has consumed, not total session calls.

---

## isLoading Race Condition Fix

```typescript
const [isLoading, setIsLoading] = useState(false);
const isLoadingRef = useRef(false);
useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);

// In autopilot timer:
if (isLoadingRef.current) return; // skip this tick, try next interval
```

---

## Verification

1. **Layout at 120×40:** TopBar 2 rows, footer 1 row, input visible, chat fills middle
2. **Resize below 100×28:** "Terminal too small — resize to at least 100×28" screen
3. **AP off (default):** Chat full width, no log panel, TopBar shows `AP: ○ OFF`
4. **`/auto on`:** Log panel appears, TopBar shows `AP: ● SEMI 5m`
5. **Semi tick:** `/auto 1m` for testing → trigger appears in chat after 1min, LLM proposes trade
6. **Full tick:** `/auto full 1m` → chat shows one-liner, log shows full decision
7. **Concurrent skip:** Manual turn in progress when autopilot fires → silent skip, no crash
8. **Config persistence:** Set `/auto full 10m` → quit → restart → TopBar shows `AP: ● FULL 10m`
9. **Budget counter:** TopBar shows `[N/10]` call count. After 8 autopilot calls in an epoch, log shows "Budget reached — skipping". On next epoch, counter resets and autopilot resumes.
10. **Budget display:** At 9/10 counter turns yellow, at 10/10 shows PAUSED in red.
