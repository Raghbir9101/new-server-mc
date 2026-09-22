'use strict';
/**
 * web-panel.js — dependency-free web control panel for the Minecraft server.
 * Wired up by server-runner.js via start(api). Uses Node built-ins only
 * (http + Server-Sent Events for realtime logs; fetch/POST for actions).
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// server.properties keys that can be applied to the RUNNING server via a command.
// Everything else takes effect only after a restart.
const LIVE_PROPS = {
  difficulty: (v) => `difficulty ${v}`,
  'white-list': (v) => (String(v) === 'true' ? 'whitelist on' : 'whitelist off'),
};

// Gamerules surfaced as instant toggles/inputs (applied live via `gamerule`).
const GAMERULES = [
  { rule: 'keepInventory', type: 'bool' },
  { rule: 'doDaylightCycle', type: 'bool' },
  { rule: 'doWeatherCycle', type: 'bool' },
  { rule: 'doMobSpawning', type: 'bool' },
  { rule: 'mobGriefing', type: 'bool' },
  { rule: 'doFireTick', type: 'bool' },
  { rule: 'doInsomnia', type: 'bool' },
  { rule: 'showDeathMessages', type: 'bool' },
  { rule: 'announceAdvancements', type: 'bool' },
  { rule: 'randomTickSpeed', type: 'int' },
];

function readProps(root) {
  const p = path.join(root, 'server.properties');
  const raw = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const lines = raw.split(/\r?\n/);
  const map = {};
  for (const line of lines) {
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    map[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return { lines, map };
}

function writeProps(root, updates) {
  const p = path.join(root, 'server.properties');
  let { lines } = readProps(root);
  const seen = new Set();
  lines = lines.map((line) => {
    if (!line || line.startsWith('#') || line.startsWith('!')) return line;
    const i = line.indexOf('=');
    if (i < 0) return line;
    const k = line.slice(0, i).trim();
    if (Object.prototype.hasOwnProperty.call(updates, k)) { seen.add(k); return `${k}=${updates[k]}`; }
    return line;
  });
  for (const k of Object.keys(updates)) if (!seen.has(k)) lines.push(`${k}=${updates[k]}`);
  fs.writeFileSync(p, lines.join('\n'));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

function start(api) {
  const { root, host, port } = api;

  // Open by default — behaves like an ordinary Node server (reachable on the port,
  // no login). Set PANEL_TOKEN to require a token; nothing else is needed.
  const token = api.token;
  const authRequired = !!token;

  function authed(req) {
    if (!authRequired) return true;
    const u = new URL(req.url, 'http://x');
    if (u.searchParams.get('token') === token) return true;
    return parseCookies(req).panel_token === token;
  }

  const PUBLIC = path.join(root, 'public');
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon' };

  const sseClients = new Set();
  api.bus.on('log', (line) => broadcast('log', line));
  api.bus.on('status', (st) => broadcast('status', JSON.stringify(st)));
  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${String(data).replace(/\n/g, '\\n')}\n\n`;
    for (const res of sseClients) { try { res.write(payload); } catch (_) {} }
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const route = u.pathname;

    // If a valid token is supplied via query, drop a cookie so future requests pass.
    if (authRequired && u.searchParams.get('token') === token) {
      res.setHeader('Set-Cookie', `panel_token=${token}; HttpOnly; SameSite=Lax; Path=/`);
    }

    // Login endpoint (accepts token, sets cookie).
    if (route === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      let t = '';
      try { t = JSON.parse(body).token || ''; } catch (_) {}
      if (!authRequired || t === token) {
        res.setHeader('Set-Cookie', `panel_token=${t}; HttpOnly; SameSite=Lax; Path=/`);
        return json(res, 200, { ok: true });
      }
      return json(res, 401, { ok: false, error: 'bad token' });
    }

    // Gate everything else.
    if (!authed(req)) {
      if (route.startsWith('/api/')) return json(res, 401, { ok: false, error: 'unauthorized' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LOGIN_HTML);
    }

    // --- Realtime log stream (SSE) ---
    if (route === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      res.write(`event: status\ndata: ${JSON.stringify(api.status())}\n\n`);
      for (const line of api.recentLogs()) res.write(`event: log\ndata: ${String(line).replace(/\n/g, '\\n')}\n\n`);
      sseClients.add(res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 20000);
      req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
      return;
    }

    if (route === '/api/status') return json(res, 200, api.status());

    if (route === '/api/command' && req.method === 'POST') {
      const body = await readBody(req);
      let cmd = '';
      try { cmd = (JSON.parse(body).command || '').trim(); } catch (_) {}
      if (!cmd) return json(res, 400, { ok: false, error: 'empty command' });
      const ok = api.sendCommand(cmd);
      return json(res, ok ? 200 : 409, { ok, error: ok ? undefined : 'server not running' });
    }

    if (route === '/api/control' && req.method === 'POST') {
      const body = await readBody(req);
      let action = '';
      try { action = JSON.parse(body).action; } catch (_) {}
      if (action === 'start') api.startServer();
      else if (action === 'stop') api.stopServer();
      else if (action === 'restart') api.restartServer();
      else return json(res, 400, { ok: false, error: 'unknown action' });
      return json(res, 200, { ok: true });
    }

    if (route === '/api/properties' && req.method === 'GET') {
      const { map } = readProps(root);
      return json(res, 200, { properties: map, live: Object.keys(LIVE_PROPS), gamerules: GAMERULES });
    }

    if (route === '/api/properties' && req.method === 'POST') {
      const body = await readBody(req);
      let updates = {};
      try { updates = JSON.parse(body).updates || {}; } catch (_) { return json(res, 400, { ok: false, error: 'bad json' }); }
      // sanitize: no newlines in values
      for (const k of Object.keys(updates)) updates[k] = String(updates[k]).replace(/[\r\n]/g, '');
      writeProps(root, updates);
      const appliedLive = [];
      const needsRestart = [];
      const running = api.status().running;
      for (const k of Object.keys(updates)) {
        if (LIVE_PROPS[k] && running) { api.sendCommand(LIVE_PROPS[k](updates[k])); appliedLive.push(k); }
        else needsRestart.push(k);
      }
      return json(res, 200, { ok: true, appliedLive, needsRestart });
    }

    if (route === '/api/gamerule' && req.method === 'POST') {
      const body = await readBody(req);
      let rule = '', value = '';
      try { const j = JSON.parse(body); rule = String(j.rule || ''); value = String(j.value || ''); } catch (_) {}
      if (!/^[A-Za-z]+$/.test(rule)) return json(res, 400, { ok: false, error: 'bad rule' });
      const ok = api.sendCommand(`gamerule ${rule} ${value}`);
      return json(res, ok ? 200 : 409, { ok });
    }

    // --- Static files (the UI) ---
    let file = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    });
  });

  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? 'localhost' : host;
    api.log(`Web panel: http://${shown}:${port}${authRequired && token ? `/?token=${token}` : ''}`);
    if (!authRequired) api.warn(`Web panel is OPEN (no auth) on ${host}:${port} — anyone who can reach it can run server commands. Set PANEL_TOKEN to require a token.`);
    else api.log('Web panel auth: PANEL_TOKEN required.');
  });

  return server;
}

const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Server Panel — Login</title><style>
:root{color-scheme:dark}body{background:#0f1216;color:#e6e6e6;font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#171b21;padding:28px;border-radius:12px;border:1px solid #262b33;width:320px}
h1{font-size:18px;margin:0 0 16px}input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #333;background:#0f1216;color:#eee;margin-bottom:12px}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}
.err{color:#f87171;font-size:13px;min-height:18px}</style></head>
<body><form class="card" onsubmit="go(event)"><h1>🔒 Server Panel</h1>
<input id="t" type="password" placeholder="Access token" autofocus>
<div class="err" id="e"></div><button>Unlock</button></form>
<script>async function go(ev){ev.preventDefault();const t=document.getElementById('t').value;
const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})});
if(r.ok){location.href='/'}else{document.getElementById('e').textContent='Invalid token'}}</script></body></html>`;

module.exports = { start };
