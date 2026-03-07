use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::Emitter;
use tauri::Manager;

struct SidecarChild {
    stdin: Option<std::process::ChildStdin>,
}

#[tauri::command]
fn send_to_sidecar(
    message: String,
    state: tauri::State<'_, Mutex<SidecarChild>>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut stdin) = guard.stdin {
        let payload = format!("{}\n", message);
        stdin
            .write_all(payload.as_bytes())
            .map_err(|e| format!("Failed to write to sidecar stdin: {}", e))?;
        stdin
            .flush()
            .map_err(|e| format!("Failed to flush sidecar stdin: {}", e))?;
        Ok(())
    } else {
        Err("Sidecar not running".into())
    }
}

#[tauri::command]
fn update_tray(
    app: tauri::AppHandle,
    daemon_running: bool,
) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let status_text = if daemon_running {
            "Autopilot: Running"
        } else {
            "Autopilot: Stopped"
        };

        let toggle_text = if daemon_running {
            "Stop Autopilot"
        } else {
            "Start Autopilot"
        };

        let tooltip = format!("Astra — {}", status_text);

        // Rebuild menu with updated labels
        let status_item = MenuItemBuilder::with_id("status", status_text)
            .enabled(false)
            .build(&app)
            .map_err(|e| e.to_string())?;
        let toggle_item = MenuItemBuilder::with_id("toggle-daemon", toggle_text)
            .build(&app)
            .map_err(|e| e.to_string())?;
        let open_item = MenuItemBuilder::with_id("open", "Open Astra")
            .build(&app)
            .map_err(|e| e.to_string())?;
        let quit_item = MenuItemBuilder::with_id("quit", "Quit")
            .build(&app)
            .map_err(|e| e.to_string())?;

        let menu = MenuBuilder::new(&app)
            .item(&status_item)
            .separator()
            .item(&toggle_item)
            .item(&open_item)
            .separator()
            .item(&quit_item)
            .build()
            .map_err(|e| e.to_string())?;

        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        tray.set_tooltip(Some(&tooltip)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Resolve the Node.js binary and sidecar entry.js paths.
/// Dev mode: uses system `node` + relative `../sidecar-dist/entry.js`.
/// Production: uses bundled node binary + entry.js from resource dir.
fn resolve_sidecar_paths(
    handle: &tauri::AppHandle,
) -> Result<(String, String), String> {
    // Allow env override for both paths
    if let Ok(path) = std::env::var("ASTRA_SIDECAR_PATH") {
        return Ok(("node".to_string(), path));
    }

    // Dev mode: sidecar-dist exists next to src-tauri/
    let dev_entry = std::path::PathBuf::from("../sidecar-dist/entry.js");
    if dev_entry.exists() {
        return Ok(("node".to_string(), dev_entry.to_string_lossy().to_string()));
    }

    // Production: bundled resources
    let resource_dir = handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {}", e))?;

    let node_binary_name = if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    };

    let node_path = resource_dir.join("node-bin").join(node_binary_name);
    let entry_path = resource_dir.join("sidecar-dist").join("entry.js");

    // Ensure bundled node binary exists
    if !node_path.exists() {
        return Err(format!(
            "Bundled Node.js binary not found at: {}",
            node_path.display()
        ));
    }

    // Ensure execute permission on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(&node_path) {
            let mut perms = metadata.permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&node_path, perms);
        }
    }

    if !entry_path.exists() {
        return Err(format!(
            "Sidecar entry.js not found at: {}",
            entry_path.display()
        ));
    }

    Ok((
        node_path.to_string_lossy().to_string(),
        entry_path.to_string_lossy().to_string(),
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(Mutex::new(SidecarChild { stdin: None }))
        .setup(|app| {
            let handle = app.handle().clone();

            // ── System tray ──
            let status_item = MenuItemBuilder::with_id("status", "Autopilot: Stopped")
                .enabled(false)
                .build(app)
                .expect("Failed to build status menu item");
            let toggle_item = MenuItemBuilder::with_id("toggle-daemon", "Start Autopilot")
                .build(app)
                .expect("Failed to build toggle menu item");
            let open_item = MenuItemBuilder::with_id("open", "Open Astra")
                .build(app)
                .expect("Failed to build open menu item");
            let quit_item = MenuItemBuilder::with_id("quit", "Quit")
                .build(app)
                .expect("Failed to build quit menu item");

            let tray_menu = MenuBuilder::new(app)
                .item(&status_item)
                .separator()
                .item(&toggle_item)
                .item(&open_item)
                .separator()
                .item(&quit_item)
                .build()
                .expect("Failed to build tray menu");

            let tray_handle = handle.clone();
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().cloned().expect("No app icon"))
                .menu(&tray_menu)
                .tooltip("Astra — Autopilot: Stopped")
                .on_menu_event(move |app_handle, event| {
                    match event.id().as_ref() {
                        "toggle-daemon" => {
                            let _ = app_handle.emit("tray:toggle-daemon", ());
                        }
                        "open" => {
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            // Quit the app — daemon keeps running independently
                            app_handle.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(&tray_handle)
                .expect("Failed to build tray icon");

            // ── Sidecar ──
            let (node_bin, sidecar_entry) = resolve_sidecar_paths(&handle)
                .expect("Failed to resolve sidecar paths");

            eprintln!("[tauri] Spawning sidecar: {} {}", node_bin, sidecar_entry);

            let mut child = Command::new(&node_bin)
                .arg(&sidecar_entry)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap_or_else(|e| {
                    panic!(
                        "Failed to spawn sidecar: {} (node={}, entry={})",
                        e, node_bin, sidecar_entry
                    )
                });

            // Take ownership of stdin for writing
            let child_stdin = child.stdin.take().expect("Failed to open sidecar stdin");

            // Store stdin handle for the send_to_sidecar command
            // NOTE: Do NOT send init here — the webview's event listener
            // isn't ready yet. The frontend sends init after registering listeners.
            {
                let state = handle.state::<Mutex<SidecarChild>>();
                state.lock().unwrap().stdin = Some(child_stdin);
            }

            // Take both stdout and stderr before moving child
            let stdout = child.stdout.take().expect("Failed to open sidecar stdout");
            let stderr = child.stderr.take().expect("Failed to open sidecar stderr");

            // Read stdout (protocol messages) in a background thread
            let emit_stdout = handle.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    match line {
                        Ok(l) if !l.trim().is_empty() => {
                            let _ = emit_stdout.emit("sidecar:message", &l);
                        }
                        Err(e) => {
                            eprintln!("[tauri] Sidecar stdout read error: {}", e);
                            break;
                        }
                        _ => {}
                    }
                }
                // stdout closed — sidecar exited
                let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
                eprintln!("[tauri] Sidecar exited with code {}", code);
                let _ = emit_stdout.emit("sidecar:exit", code);
            });
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    match line {
                        Ok(l) => eprintln!("[sidecar] {}", l),
                        Err(_) => break,
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![send_to_sidecar, update_tray])
        .on_window_event(|window, event| {
            // When user closes the window, hide it instead of quitting.
            // The app stays alive in the system tray. "Quit" in tray menu exits for real.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
