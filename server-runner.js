#!/usr/bin/env node
/**
 * server-runner.js
 * -----------------
 * Runs the Minecraft (Spigot) server with:
 *   - dependency preflight (Node, Java >= MIN_JAVA, git, repo/remote, jar, EULA)
 *   - auto-commit + push to GitHub every COMMIT_INTERVAL seconds (world flushed first)
 *   - a built-in web control panel (live logs, run commands, edit settings, start/stop/restart)
 *
 * Target OS: Ubuntu / Linux (POSIX-friendly). Also works on macOS / Windows.
 * No npm dependencies — Node built-ins only.
 *
 * Usage:   node server-runner.js
 *
 * Env vars (all optional):
 *   JAVA_BIN         java path            (default: "java")
 *   SERVER_JAR       jar filename         (default: auto-detect spigot/paper/*.jar)
 *   XMX / XMS        max / min heap       (default: 4G / 2G)
 *   COMMIT_INTERVAL  seconds per commit   (default: 60)
 *   GIT_REMOTE       remote name          (default: "origin")
 *   GIT_BRANCH       branch               (default: current branch)
 *   AUTO_PUSH        "false" to disable   (default: push if a remote exists)
 *   AUTO_RESTART     "false" to disable   (default: restart the server if it crashes)
 *   MIN_JAVA         required java major  (default: 25)
 *   PANEL_PORT       web panel port       (default: 8080)   0 disables the panel
 *   PANEL_HOST       bind address         (default: 127.0.0.1; use 0.0.0.0 for LAN)
 *   PANEL_TOKEN      access token         (default: none on localhost; auto-generated if exposed)
 */

'use strict';

const { spawn, execFileSync, execSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ROOT = __dirname;
const JAVA_BIN = process.env.JAVA_BIN || 'java';
const XMX = process.env.XMX || '4G';
const XMS = process.env.XMS || '2G';
const MIN_JAVA = parseInt(process.env.MIN_JAVA || '25', 10);
const COMMIT_INTERVAL_MS = parseInt(process.env.COMMIT_INTERVAL || '60', 10) * 1000;
const GIT_REMOTE = process.env.GIT_REMOTE || 'origin';
const AUTO_RESTART = process.env.AUTO_RESTART !== 'false';
const FLUSH_WAIT_MS = 1500;

// ---------------------------------------------------------------------------
// Logging + event bus (the web panel subscribes to this)
// ---------------------------------------------------------------------------
const bus = new EventEmitter();
bus.setMaxListeners(0);
const LOG_BUFFER_MAX = 500;
const logBuffer = [];

const ts = () => new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
function emitLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  bus.emit('log', line);
}
const log = (m) => { const s = `\x1b[36m[runner ${ts()}]\x1b[0m ${m}`; console.log(s); emitLog(`[runner] ${m}`); };
const warn = (m) => { const s = `\x1b[33m[runner ${ts()}] WARN:\x1b[0m ${m}`; console.warn(s); emitLog(`[runner] WARN: ${m}`); };
const fail = (m) => { console.error(`\x1b[31m[runner ${ts()}] ERROR:\x1b[0m ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tryRun(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    return { ok: true, out: (out || '').toString() };
  } catch (e) {
    return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).toString(), err: e };
  }
}
function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString().trim();
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------
function detectJavaMajor() {
  let out;
  try { out = execSync(`"${JAVA_BIN}" -version 2>&1`, { encoding: 'utf8' }); }
  catch (e) { return null; }
  const m = out.match(/version "(\d+)(?:\.(\d+))?[^"]*"/);
  if (!m) return null;
  let major = parseInt(m[1], 10);
  if (major === 1 && m[2]) major = parseInt(m[2], 10);
  return { major, raw: out.split('\n')[0].trim() };
}

function findServerJar() {
  if (process.env.SERVER_JAR) return process.env.SERVER_JAR;
  const preferred = 'spigot-26.1.2.jar';
  if (fs.existsSync(path.join(ROOT, preferred))) return preferred;
  const jars = fs.readdirSync(ROOT).filter((f) => /^(spigot|paper|purpur|craftbukkit|bukkit).*\.jar$/i.test(f));
  return jars[0] || null;
}

function preflight() {
  log('Running preflight checks...');
  log(`  ✓ Node ${process.version}`);

  const gv = tryRun('git', ['--version']);
  if (!gv.ok) fail('git is not installed. On Ubuntu: sudo apt update && sudo apt install -y git');
  log(`  ✓ ${gv.out.trim()}`);

  const jv = detectJavaMajor();
  if (!jv) {
    fail(
      `Java not found (looked for "${JAVA_BIN}").\n` +
      `  This server needs Java ${MIN_JAVA}. Install Temurin ${MIN_JAVA} on Ubuntu:\n` +
      `    sudo apt install -y wget apt-transport-https gpg\n` +
      `    wget -qO- https://packages.adoptium.net/artifactory/api/gpg/key/public | sudo gpg --dearmor -o /etc/apt/keyrings/adoptium.gpg\n` +
      `    echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb $(. /etc/os-release && echo $VERSION_CODENAME) main" | sudo tee /etc/apt/sources.list.d/adoptium.list\n` +
      `    sudo apt update && sudo apt install -y temurin-${MIN_JAVA}-jdk\n` +
      `  Or point at a JDK: JAVA_BIN=/path/to/jdk-${MIN_JAVA}/bin/java node server-runner.js`
    );
  }
  if (jv.major < MIN_JAVA) fail(`Java ${jv.major} found ("${jv.raw}"), but this build requires Java ${MIN_JAVA}+.`);
  log(`  ✓ Java ${jv.major} ("${jv.raw}")`);

  const jar = findServerJar();
  if (!jar || !fs.existsSync(path.join(ROOT, jar))) fail(`No server jar found in ${ROOT}. Set SERVER_JAR=<file>.jar`);
  log(`  ✓ Server jar: ${jar}`);

  const inRepo = tryRun('git', ['rev-parse', '--is-inside-work-tree']);
  if (!inRepo.ok || inRepo.out.trim() !== 'true') fail(`${ROOT} is not a git repo. Run: git init && git remote add ${GIT_REMOTE} <url>`);
  log('  ✓ Inside a git repository');

  const name = tryRun('git', ['config', 'user.name']);
  const email = tryRun('git', ['config', 'user.email']);
  if (!name.ok || !name.out.trim() || !email.ok || !email.out.trim()) {
    try {
      git(['config', 'user.name', 'mc-server-bot']);
      git(['config', 'user.email', 'mc-server-bot@localhost']);
      warn('No git identity configured; set a local one ("mc-server-bot") for auto-commits.');
    } catch (e) { warn(`Could not set a git identity: ${e.message}`); }
  }

  const branch = process.env.GIT_BRANCH || tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim() || 'main';
  log(`  ✓ Branch: ${branch}`);

  const remotes = tryRun('git', ['remote']).out.split('\n').map((s) => s.trim()).filter(Boolean);
  let pushEnabled = process.env.AUTO_PUSH !== 'false';
  if (!remotes.includes(GIT_REMOTE)) {
    pushEnabled = false;
    warn(`No git remote "${GIT_REMOTE}" — commits will be LOCAL only. Add one: git remote add ${GIT_REMOTE} <url>`);
  } else if (!pushEnabled) {
    warn('AUTO_PUSH=false — committing locally without pushing.');
  } else {
    log(`  ✓ Remote "${GIT_REMOTE}" present — auto-push enabled`);
  }

  const eulaPath = path.join(ROOT, 'eula.txt');
  if (fs.existsSync(eulaPath)) {
    const accepted = /eula\s*=\s*true/i.test(fs.readFileSync(eulaPath, 'utf8'));
    if (!accepted) warn('eula.txt is not accepted (eula=false). The server will stop until you set eula=true.');
    else log('  ✓ EULA accepted');
  } else {
    log('  • eula.txt will be generated on first run (then set eula=true).');
  }

  log('Preflight passed.\n');
  return { jar, branch, pushEnabled };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------
let cfg = null;
let server = null;
let serverReady = false;
let shuttingDown = false;
let intentionalStop = false;   // set when we (not a crash) bring the server down
let committing = false;
let commitTimer = null;
let recentStartTimes = [];     // crash-loop guard

function status() {
  return {
    running: !!server && server.exitCode === null && server.signalCode === null,
    ready: serverReady,
    pid: server ? server.pid : null,
    jar: cfg && cfg.jar,
    branch: cfg && cfg.branch,
    pushEnabled: cfg && cfg.pushEnabled,
    commitIntervalSec: COMMIT_INTERVAL_MS / 1000,
    autoRestart: AUTO_RESTART,
  };
}
function emitStatus() { bus.emit('status', status()); }

function sendCommand(cmd) {
  if (server && server.stdin && server.stdin.writable) {
    server.stdin.write(cmd + '\n');
    emitLog(`> ${cmd}`);
    return true;
  }
  return false;
}

function startServer() {
  if (server && server.exitCode === null) { warn('Server already running.'); return; }
  serverReady = false;
  intentionalStop = false;
  const args = [`-Xmx${XMX}`, `-Xms${XMS}`, '-jar', cfg.jar, 'nogui'];
  log(`Starting server: ${JAVA_BIN} ${args.join(' ')}`);
  recentStartTimes.push(Date.now());
  recentStartTimes = recentStartTimes.filter((t) => Date.now() - t < 60000);

  server = spawn(JAVA_BIN, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], detached: true });

  try { process.stdin.unpipe(); } catch (_) {}
  try { process.stdin.pipe(server.stdin); } catch (_) {}
  process.stdin.on('error', () => {});
  server.stdin.on('error', () => {});

  let tail = '';
  const onChunk = (buf) => {
    process.stdout.write(buf);
    tail += buf.toString();
    let nl;
    while ((nl = tail.indexOf('\n')) >= 0) {
      const line = tail.slice(0, nl).replace(/\r$/, '');
      tail = tail.slice(nl + 1);
      emitLog(line);
      if (!serverReady && line.includes('Done (')) { serverReady = true; log('Server ready — auto-commit active.'); emitStatus(); }
    }
  };
  server.stdout.on('data', onChunk);
  server.stderr.on('data', onChunk);

  server.on('exit', (code, signal) => {
    serverReady = false;
    emitStatus();
    if (shuttingDown || intentionalStop) return; // handled elsewhere
    warn(`Server exited unexpectedly (code=${code}, signal=${signal}).`);
    doCommit('auto-backup (server exit)');
    if (AUTO_RESTART) {
      if (recentStartTimes.length >= 3) {
        warn('Crash loop detected (3 starts within 60s) — not restarting. Use the panel to start it once fixed.');
        return;
      }
      log('Auto-restarting the server in 3s...');
      setTimeout(() => startServer(), 3000);
    }
  });

  emitStatus();
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server || server.exitCode !== null) return resolve();
    intentionalStop = true;
    const onExit = () => resolve();
    server.once('exit', onExit);
    sendCommand('save-all');
    sendCommand('stop');
    setTimeout(() => {
      if (server && server.exitCode === null) {
        try { process.kill(-server.pid, 'SIGKILL'); } catch (_) { try { server.kill('SIGKILL'); } catch (_) {} }
      }
    }, 30000);
  });
}

async function restartServer() {
  log('Restarting server...');
  await stopServer();
  await sleep(500);
  startServer();
}

// ---------------------------------------------------------------------------
// Auto-commit
// ---------------------------------------------------------------------------
function doCommit(prefix) {
  try {
    git(['add', '-A']);
    const st = git(['status', '--porcelain']);
    if (!st) { log('No changes to commit.'); return; }
    const files = st.split('\n').filter(Boolean).length;
    git(['commit', '-q', '-m', `${prefix}: ${ts()} (${files} file(s))`]);
    log(`Committed ${files} changed path(s).`);
    if (cfg.pushEnabled) {
      try { git(['push', '-u', GIT_REMOTE, cfg.branch]); log(`Pushed to ${GIT_REMOTE}/${cfg.branch}.`); }
      catch (e) { warn(`Push failed (saved locally): ${(e.stderr || e.message || '').toString().trim()}`); }
    }
  } catch (e) {
    warn(`Commit failed: ${(e.stderr || e.message || '').toString().trim()}`);
  }
}

async function commitTick() {
  if (committing || shuttingDown) return;
  committing = true;
  try {
    if (serverReady && sendCommand('save-all flush')) await sleep(FLUSH_WAIT_MS);
    doCommit('auto-backup');
  } finally { committing = false; }
}

// ---------------------------------------------------------------------------
// Graceful shutdown of the whole runner
// ---------------------------------------------------------------------------
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Received ${signal} — shutting down gracefully...`);
  if (commitTimer) clearInterval(commitTimer);
  await stopServer();
  log('Final commit...');
  doCommit('auto-backup (shutdown)');
  log('Bye.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  process.chdir(ROOT);
  cfg = preflight();
  startServer();
  commitTimer = setInterval(commitTick, COMMIT_INTERVAL_MS);
  log(`Auto-commit every ${COMMIT_INTERVAL_MS / 1000}s scheduled.`);

  // Web control panel (optional).
  const panelPort = parseInt(process.env.PANEL_PORT || '8080', 10);
  if (panelPort > 0) {
    try {
      require('./web-panel').start({
        root: ROOT,
        host: process.env.PANEL_HOST || '127.0.0.1',
        port: panelPort,
        token: process.env.PANEL_TOKEN || null,
        allowNoAuth: process.env.PANEL_ALLOW_NO_AUTH === 'true',
        bus,
        status,
        recentLogs: () => logBuffer.slice(),
        sendCommand,
        startServer,
        stopServer,
        restartServer,
        log, warn,
      });
    } catch (e) { warn(`Web panel failed to start: ${e.message}`); }
  } else {
    log('Web panel disabled (PANEL_PORT=0).');
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
