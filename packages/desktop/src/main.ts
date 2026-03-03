import { app, BrowserWindow, ipcMain, Menu, nativeImage } from "electron";
import * as path from "path";
import * as os from "os";
import * as pty from "node-pty";
import { themes, themeNames } from "./themes";

// Set app name early — before any window or menu is created.
// In dev mode Electron defaults to "Electron" from its own package.json.
app.name = "Astra";

let mainWindow: BrowserWindow | null = null;
let ptyProcess: pty.IPty | null = null;

function getCliPath(): string {
  if (!app.isPackaged) {
    // Dev: use normal CLI bundle (has external deps resolved via node_modules)
    return path.resolve(__dirname, "../../../dist/astra.js");
  }
  // Production: self-contained bundle shipped as extraResource
  return path.join(process.resourcesPath, "dist-desktop", "astra.js");
}

function getShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  return process.env.SHELL || "/bin/zsh";
}

function getNodePath(): string {
  if (app.isPackaged) {
    // Use Electron's bundled Node.js binary in production
    // process.execPath is the Electron binary which can also run Node scripts
    return process.execPath;
  }
  return "node";
}

/**
 * Build a usable PATH for the PTY environment.
 * Packaged macOS apps get a minimal PATH (/usr/bin:/bin).
 * We add common locations so the CLI can find system tools.
 */
function getEnvPath(): string {
  const sep = process.platform === "win32" ? ";" : ":";
  const base = process.env.PATH || (process.platform === "win32" ? "" : "/usr/bin:/bin");
  const parts = base.split(sep);

  if (process.platform !== "win32") {
    const extras = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      `${os.homedir()}/.nvm/current/bin`,
      `${os.homedir()}/.volta/bin`,
      `${os.homedir()}/.local/bin`,
    ];
    for (const p of extras) {
      if (!parts.includes(p)) parts.push(p);
    }
  }

  return parts.join(sep);
}

function getIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "icon.png");
  }
  return path.resolve(__dirname, "../resources/icon.png");
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    minWidth: 1024,
    minHeight: 768,
    backgroundColor: "#002633",
    icon: getIconPath(),
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 12 } }
      : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Required for node-pty preload
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow!.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function spawnPty(cols: number, rows: number): void {
  const cliPath = getCliPath();

  if (app.isPackaged) {
    // Production: use Electron's own Node.js runtime via ELECTRON_RUN_AS_NODE.
    // The self-contained bundle has zero external deps — no node_modules needed.
    const isWin = process.platform === "win32";
    ptyProcess = pty.spawn(process.execPath, [cliPath], {
      name: isWin ? "" : "xterm-256color",
      cols,
      rows,
      cwd: os.homedir(),
      ...(isWin ? { useConpty: true, conptyInheritCursor: true } : {}),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PATH: getEnvPath(),
        ...(isWin ? {} : { TERM: "xterm-256color" }),
        COLORTERM: "truecolor",
        FORCE_COLOR: "3",
      },
    });
  } else {
    // Dev: spawn via login shell so user's profile is loaded (.zprofile, .bash_profile)
    const shell = getShell();
    ptyProcess = pty.spawn(shell, ["-l", "-c", `node "${cliPath}"`], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: os.homedir(),
      env: {
        ...process.env,
        PATH: getEnvPath(),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FORCE_COLOR: "3",
      },
    });
  }

  ptyProcess.onData((data: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal-data", data);
    }
  });

  ptyProcess.onExit(() => {
    ptyProcess = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });
}

function setupIpc(): void {
  ipcMain.on("terminal-input", (_event, data: string) => {
    ptyProcess?.write(data);
  });

  ipcMain.on("terminal-resize", (_event, { cols, rows }: { cols: number; rows: number }) => {
    try {
      ptyProcess?.resize(cols, rows);
    } catch {
      // Resize can throw if PTY already exited
    }
  });

  ipcMain.on("terminal-ready", (_event, { cols, rows }: { cols: number; rows: number }) => {
    if (!ptyProcess) {
      spawnPty(cols, rows);
    }
  });

  ipcMain.on("terminal-restart", () => {
    if (ptyProcess) {
      ptyProcess.kill();
      ptyProcess = null;
    }
    // Renderer will send terminal-ready again with dimensions
  });
}

function killPty(): Promise<void> {
  return new Promise((resolve) => {
    if (!ptyProcess) {
      resolve();
      return;
    }

    const proc = ptyProcess;
    ptyProcess = null;

    // Give it 2 seconds to exit gracefully
    const forceKillTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already dead
      }
      resolve();
    }, 2000);

    proc.onExit(() => {
      clearTimeout(forceKillTimer);
      resolve();
    });

    try {
      proc.kill("SIGTERM");
    } catch {
      clearTimeout(forceKillTimer);
      resolve();
    }
  });
}

function buildMenu(): void {
  const themeSubmenu = themeNames.map((key) => ({
    label: themes[key].name,
    type: "radio" as const,
    click: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("theme-change", key);
      }
    },
  }));

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Theme",
      submenu: themeSubmenu,
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // Set dock icon on macOS (BrowserWindow icon doesn't affect dock)
  if (process.platform === "darwin") {
    const icon = nativeImage.createFromPath(getIconPath());
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }

  setupIpc();
  buildMenu();
  createWindow();

  app.on("activate", () => {
    // macOS: re-create window when dock icon clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", async () => {
  await killPty();
  app.quit();
});

app.on("before-quit", async (event) => {
  if (ptyProcess) {
    event.preventDefault();
    await killPty();
    app.quit();
  }
});
