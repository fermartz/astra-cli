import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

// Theme definitions inlined for the renderer bundle (no cross-process import)
const themes: Record<string, Record<string, string>> = {
  dark: {
    background: "#000000",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    selectionBackground: "#264f78",
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2472c8",
    magenta: "#bc3fbc",
    cyan: "#11a8cd",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#e5e5e5",
  },
  dracula: {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#f8f8f2",
    selectionBackground: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  cyberWave: {
    background: "#002633",
    foreground: "#ffffff",
    cursor: "#007972",
    selectionBackground: "#7b008f",
    black: "#616161",
    red: "#ff8272",
    green: "#b4fa72",
    yellow: "#fefdc2",
    blue: "#a5d5fe",
    magenta: "#ff8ffd",
    cyan: "#d0d1fe",
    white: "#f1f1f1",
    brightBlack: "#8e8e8e",
    brightRed: "#ffc4bd",
    brightGreen: "#d6fcb9",
    brightYellow: "#fefdd5",
    brightBlue: "#c1e3fe",
    brightMagenta: "#ffb1fe",
    brightCyan: "#e5e6fe",
    brightWhite: "#feffff",
  },
  solarizedDark: {
    background: "#002b36",
    foreground: "#839496",
    cursor: "#268bd2",
    selectionBackground: "#073642",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#002b36",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  nord: {
    background: "#2e3440",
    foreground: "#d8dee9",
    cursor: "#d8dee9",
    selectionBackground: "#434c5e",
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
};

declare global {
  interface Window {
    terminal: {
      onData: (cb: (data: string) => void) => void;
      write: (data: string) => void;
      resize: (cols: number, rows: number) => void;
      ready: (cols: number, rows: number) => void;
      onExit: (cb: (code: number) => void) => void;
      restart: () => void;
      onThemeChange: (cb: (themeKey: string) => void) => void;
    };
  }
}

function getTheme(key: string): Record<string, string> {
  return themes[key] || themes.dark;
}

function getSavedTheme(): string {
  return localStorage.getItem("astra-theme") || "cyberWave";
}

function saveTheme(key: string): void {
  localStorage.setItem("astra-theme", key);
}

const currentThemeKey = getSavedTheme();
const currentTheme = getTheme(currentThemeKey);

const term = new Terminal({
  cursorBlink: true,
  cursorStyle: "bar",
  fontSize: 14,
  fontFamily: '"SF Mono", "JetBrains Mono", "Fira Code", "Cascadia Code", "Menlo", monospace',
  theme: currentTheme,
  allowProposedApi: true,
  scrollback: 0,
});

function applyTheme(key: string): void {
  const theme = getTheme(key);
  term.options.theme = theme;
  document.body.style.background = theme.background;
  saveTheme(key);
}

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

const container = document.getElementById("terminal")!;
term.open(container);

// Try WebGL renderer for performance, fall back to canvas
try {
  const webglAddon = new WebglAddon();
  webglAddon.onContextLoss(() => {
    webglAddon.dispose();
  });
  term.loadAddon(webglAddon);
} catch {
  // WebGL not available — canvas renderer is fine
}

// Apply saved background to body
document.body.style.background = currentTheme.background;

fitAddon.fit();

// PTY -> xterm
window.terminal.onData((data: string) => {
  term.write(data);
});

// xterm -> PTY
term.onData((data: string) => {
  window.terminal.write(data);
});

// Theme switching from menu
window.terminal.onThemeChange((key: string) => {
  applyTheme(key);
});

// Resize handling
const handleResize = (): void => {
  fitAddon.fit();
  window.terminal.resize(term.cols, term.rows);
};

window.addEventListener("resize", handleResize);

// Debounced resize for smoother experience
let resizeTimer: ReturnType<typeof setTimeout>;
const resizeObserver = new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(handleResize, 50);
});
resizeObserver.observe(container);

// Handle PTY exit
const exitOverlay = document.getElementById("exit-overlay")!;
const restartBtn = document.getElementById("restart-btn")!;

window.terminal.onExit((_code: number) => {
  exitOverlay.classList.remove("hidden");
});

restartBtn.addEventListener("click", () => {
  exitOverlay.classList.add("hidden");
  term.clear();
  term.reset();
  window.terminal.ready(term.cols, term.rows);
});

// Signal main process that terminal is ready
window.terminal.ready(term.cols, term.rows);

// Focus terminal
term.focus();
