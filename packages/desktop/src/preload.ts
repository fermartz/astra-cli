import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("terminal", {
  /** PTY stdout → renderer */
  onData: (cb: (data: string) => void) => {
    ipcRenderer.on("terminal-data", (_event, data) => cb(data));
  },

  /** Renderer keystrokes → PTY stdin */
  write: (data: string) => {
    ipcRenderer.send("terminal-input", data);
  },

  /** Notify main process of terminal dimensions */
  resize: (cols: number, rows: number) => {
    ipcRenderer.send("terminal-resize", { cols, rows });
  },

  /** Signal that the renderer terminal is ready */
  ready: (cols: number, rows: number) => {
    ipcRenderer.send("terminal-ready", { cols, rows });
  },

  /** PTY process exited */
  onExit: (cb: (code: number) => void) => {
    ipcRenderer.on("terminal-exit", (_event, code) => cb(code));
  },

  /** Request PTY restart */
  restart: () => {
    ipcRenderer.send("terminal-restart");
  },

  /** Theme changed from menu */
  onThemeChange: (cb: (themeKey: string) => void) => {
    ipcRenderer.on("theme-change", (_event, key) => cb(key));
  },
});
