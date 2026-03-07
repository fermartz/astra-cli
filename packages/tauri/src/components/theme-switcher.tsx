import { useState, useRef, useEffect } from "react";
import { Sun, Moon, Palette, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { THEMES, type ThemeId, type ColorMode } from "@/lib/themes";

interface ThemeSwitcherProps {
  theme: ThemeId;
  mode: ColorMode;
  onThemeChange: (id: ThemeId) => void;
  onToggleMode: () => void;
}

export function ThemeSwitcher({
  theme,
  mode,
  onThemeChange,
  onToggleMode,
}: ThemeSwitcherProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  const current = THEMES.find((t) => t.id === theme);

  return (
    <div className="flex items-center gap-1">
      <div className="relative" ref={menuRef}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(!open)}
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <Palette className="h-3 w-3" />
          {current?.label}
        </Button>
        {open && (
          <div className="absolute right-0 top-full mt-1 z-50 min-w-[180px] rounded-md border border-border bg-popover p-1 shadow-md">
            {THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  onThemeChange(t.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <Check
                  className={`h-3 w-3 ${t.id === theme ? "opacity-100" : "opacity-0"}`}
                />
                <span className="font-medium">{t.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={onToggleMode}
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        title={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      >
        {mode === "dark" ? (
          <Sun className="h-3 w-3" />
        ) : (
          <Moon className="h-3 w-3" />
        )}
      </Button>
    </div>
  );
}
