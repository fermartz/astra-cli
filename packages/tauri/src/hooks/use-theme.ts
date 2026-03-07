import { useState, useEffect, useCallback } from "react";
import {
  type ThemeId,
  type ColorMode,
  getSavedTheme,
  getSavedMode,
  saveTheme,
  saveMode,
  applyTheme,
} from "@/lib/themes";

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>(getSavedTheme);
  const [mode, setModeState] = useState<ColorMode>(getSavedMode);

  useEffect(() => {
    applyTheme(theme, mode);
  }, [theme, mode]);

  const setTheme = useCallback((id: ThemeId) => {
    setThemeState(id);
    saveTheme(id);
  }, []);

  const setMode = useCallback((m: ColorMode) => {
    setModeState(m);
    saveMode(m);
  }, []);

  const toggleMode = useCallback(() => {
    setModeState((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      saveMode(next);
      return next;
    });
  }, []);

  return { theme, mode, setTheme, setMode, toggleMode };
}
