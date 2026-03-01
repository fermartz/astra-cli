/**
 * Daemon manager — start, stop, and check status of the full autopilot daemon.
 *
 * The daemon is a detached child process running the same bundle with --daemon flag.
 * It keeps trading on schedule even when the TUI is closed.
 * PID is stored per-agent so multiple agents can each have their own daemon.
 */

import { spawn } from "node:child_process";
import process from "node:process";
import { loadDaemonPid, saveDaemonPid, clearDaemonPid } from "../config/store.js";

/** Check whether a process with the given PID is currently alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, no actual signal sent
    return true;
  } catch {
    return false;
  }
}

/** Check whether the full autopilot daemon is running for a given agent. */
export function isDaemonRunning(agentName: string): boolean {
  const pid = loadDaemonPid(agentName);
  if (pid === null) return false;
  if (isProcessAlive(pid)) return true;
  // Stale PID — clean it up
  clearDaemonPid(agentName);
  return false;
}

/**
 * Start the full autopilot daemon for a given agent.
 * No-ops if already running. The daemon is detached and survives TUI exit.
 */
export function startDaemon(agentName: string): void {
  if (isDaemonRunning(agentName)) return;

  const child = spawn(process.execPath, [process.argv[1], "--daemon"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });

  child.unref(); // allow parent to exit independently

  if (child.pid) {
    saveDaemonPid(agentName, child.pid);
  }
}

/**
 * Stop the full autopilot daemon for a given agent.
 * Sends SIGTERM and clears the PID file.
 */
export function stopDaemon(agentName: string): void {
  const pid = loadDaemonPid(agentName);
  if (pid !== null && isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }
  clearDaemonPid(agentName);
}
