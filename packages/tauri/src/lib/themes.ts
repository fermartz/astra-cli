export type ThemeId = "perpetuity" | "cosmic-night" | "vercel" | "ocean-breeze" | "cyberpunk" | "cyber-wave";
export type ColorMode = "light" | "dark";

export interface ThemeMeta {
  id: ThemeId;
  label: string;
}

export const THEMES: ThemeMeta[] = [
  { id: "perpetuity", label: "Perpetuity" },
  { id: "cosmic-night", label: "Cosmic Night" },
  { id: "vercel", label: "Vercel" },
  { id: "ocean-breeze", label: "Ocean Breeze" },
  { id: "cyberpunk", label: "Cyberpunk" },
  { id: "cyber-wave", label: "Cyber Wave" },
];

const STORAGE_KEY = "astra-theme";
const MODE_KEY = "astra-color-mode";

export function getSavedTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && THEMES.some((t) => t.id === saved)) return saved as ThemeId;
  } catch {}
  return "perpetuity";
}

export function saveTheme(id: ThemeId) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {}
}

export function getSavedMode(): ColorMode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  return "dark";
}

export function saveMode(mode: ColorMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {}
}

export function applyTheme(id: ThemeId, mode: ColorMode) {
  const root = document.documentElement;
  root.setAttribute("data-theme", id);
  root.classList.toggle("dark", mode === "dark");
}
