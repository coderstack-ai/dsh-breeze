// dsh-breeze — optional local server lifecycle.
//
// Only used when `autostart` is on and the configured endpoint does not answer.
// A remote endpoint (or a server the person starts by hand) never triggers a
// spawn: the plugin reports that it is unreachable and says which setting to
// fix. The spawned process is detached and tracked in the state directory so a
// second tool call does not start a second model load.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { health } from './breeze-client.mjs';
import { stateHome } from './config.mjs';

function pidFile() {
  return path.join(stateHome(), 'server.pid.json');
}

function readPid() {
  try {
    const raw = JSON.parse(fs.readFileSync(pidFile(), 'utf8'));
    if (raw && Number.isInteger(raw.pid)) return raw;
  } catch {
    // absent or broken: treat as "no server we started"
  }
  return null;
}

function writePid(record) {
  const file = pidFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function clearPid() {
  try {
    fs.unlinkSync(pidFile());
  } catch {
    // already gone
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Is the configured endpoint answering right now? */
export async function probe(config, { timeoutMs = 6000 } = {}) {
  try {
    const info = await health(config, { timeoutMs });
    return { reachable: true, ...info };
  } catch (error) {
    return { reachable: false, error: String(error && error.message ? error.message : error) };
  }
}

/**
 * Make sure the endpoint answers, starting a local server when that is
 * configured. Returns { reachable, started, pid, sampleRate, note }.
 */
export async function ensureServer(config, { signal } = {}) {
  const first = await probe(config);
  if (first.reachable) return { ...first, started: false };

  const command = String(config.serverCommand || '').trim();
  if (!config.autostart || !command) {
    return {
      reachable: false,
      started: false,
      note: first.error,
      hint: config.autostart
        ? 'autostart is on but serverCommand is empty: set `serverCommand` (and `serverArgs`) in the breeze config, or start breeze-server yourself'
        : 'no server at this endpoint: start breeze-server yourself, or set `autostart` and `serverCommand` to let the plugin start it',
    };
  }

  const tracked = readPid();
  if (tracked && isAlive(tracked.pid)) {
    // A process we started is alive but not answering yet: wait instead of
    // spawning a second copy, which would load the model twice.
    const ready = await waitForHealth(config, tracked.pid, config.startupTimeoutMs, signal);
    if (ready.reachable) return { ...ready, started: false, pid: tracked.pid, note: 'attached to an already running local server' };
    return { ...ready, started: false, pid: tracked.pid, note: ready.error };
  }

  const args = Array.isArray(config.serverArgs) ? config.serverArgs : [];
  let child;
  try {
    child = spawn(command, args, {
      cwd: config.serverCwd ? path.resolve(config.serverCwd) : undefined,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
  } catch (error) {
    return { reachable: false, started: false, note: `spawn failed: ${error && error.message ? error.message : error}` };
  }
  child.unref?.();
  const pid = child.pid;
  if (!pid) return { reachable: false, started: false, note: 'spawn returned no pid' };
  writePid({ pid, command, args, startedAt: new Date().toISOString() });

  const ready = await waitForHealth(config, pid, config.startupTimeoutMs, signal);
  if (!ready.reachable) return { ...ready, started: true, pid, note: ready.error };
  return { ...ready, started: true, pid, note: 'started a local breeze-server' };
}

async function waitForHealth(config, pid, timeoutMs, signal) {
  const budget = Math.max(5000, Number(timeoutMs) || 180000);
  const deadline = Date.now() + budget;
  let last = '';
  while (Date.now() < deadline) {
    if (signal && signal.aborted) return { reachable: false, error: 'aborted while waiting for the server' };
    const now = await probe(config, { timeoutMs: 4000 });
    if (now.reachable) return now;
    last = now.error;
    if (pid && !isAlive(pid)) {
      return { reachable: false, error: `server process ${pid} exited before answering /health (${last})` };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { reachable: false, error: `server did not answer /health within ${Math.round(budget / 1000)}s (${last})` };
}

/** Stop only a server this plugin started. Returns what happened. */
export function stopServer() {
  const tracked = readPid();
  if (!tracked) return { stopped: false, note: 'no server started by this plugin' };
  if (!isAlive(tracked.pid)) {
    clearPid();
    return { stopped: false, note: `tracked server ${tracked.pid} is not running` };
  }
  try {
    process.kill(tracked.pid);
    clearPid();
    return { stopped: true, pid: tracked.pid };
  } catch (error) {
    return { stopped: false, note: `kill failed: ${error && error.message ? error.message : error}` };
  }
}
