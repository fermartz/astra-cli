import { useState, useRef, useEffect } from "react";
import { ChevronDown, Check } from "lucide-react";
import type { AgentInfo } from "@/lib/protocol";

interface AgentSwitcherProps {
  currentAgent: string | null;
  agents: AgentInfo[];
  onRequestList: () => void;
  onSwitch: (name: string) => void;
  disabled: boolean;
}

export function AgentSwitcher({
  currentAgent,
  agents,
  onRequestList,
  onSwitch,
  disabled,
}: AgentSwitcherProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const handleToggle = () => {
    if (disabled) return;
    const next = !open;
    setOpen(next);
    if (next) onRequestList();
  };

  const handleSelect = (name: string) => {
    if (name === currentAgent) {
      setOpen(false);
      return;
    }
    setOpen(false);
    onSwitch(name);
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={handleToggle}
        disabled={disabled}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {currentAgent ?? "No agent"}
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[200px] rounded-md border border-border bg-popover p-1 shadow-md">
          {agents.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">Loading...</div>
          )}
          {agents.map((agent) => (
            <button
              key={agent.name}
              onClick={() => handleSelect(agent.name)}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            >
              <Check
                className={`h-3 w-3 shrink-0 ${agent.active ? "opacity-100" : "opacity-0"}`}
              />
              <div className="min-w-0">
                <div className={`text-sm ${agent.active ? "font-medium" : ""}`}>
                  {agent.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  {agent.journeyStage}
                  {agent.status !== "unknown" && ` · ${agent.status}`}
                </div>
              </div>
              <span
                className={`ml-auto h-2 w-2 rounded-full shrink-0 ${
                  agent.active ? "bg-green-500" : "bg-muted-foreground/30"
                }`}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
