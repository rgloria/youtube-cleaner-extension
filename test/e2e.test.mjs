/*
 * End-to-end: loads the real extension into Chrome for Testing (headless),
 * starts a run from the popup context and lets the background worker drive a
 * tab through locally served mock YouTube pages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChromeForTesting() {
  if (process.env.CHROME_EXT_BIN) return process.env.CHROME_EXT_BIN;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  let dirs = [];
  try { dirs = (await readdir(cache)).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])); } catch { return null; }
  for (const d of dirs) {
    for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
                       'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
                       'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = join(cache, d, rel);
      try { await stat(p); return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

// Unpacked extension ids are derived from the absolute path.
const extensionIdFor = (path) => createHash('sha256').update(path).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

function startMockServer() {
  const types = { '.js': 'text/javascript', '.html': 'text/html' };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/youtubei/v1/')) {
      const status = Number(url.searchParams.get('mock_status') || 200);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200 ? '{"status":"STATUS_SUCCEEDED"}' : '{"error":{"code":' + status + ',"status":"ABORTED"}}');
      return;
    }
    let file = null;
    if (url.pathname === '/mock-youtube.js' || url.pathname === '/e2e-page.js') file = join(here, url.pathname.slice(1));
    else if (['/feed/channels', '/feed/playlists', '/playlist'].includes(url.pathname)) file = join(here, 'e2e-page.html');
    if (!file) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'text/plain' });
    res.end(await readFile(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port })));
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); return new CDP(ws); }
  send(method, params, sessionId) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId })); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  close() { this.ws.close(); }
}

test('the packaged extension runs a full cleanup through the background worker', { timeout: 120000 }, async (t) => {
  const chrome = await findChromeForTesting();
  if (!chrome) { t.skip('Chrome for Testing not found (set CHROME_EXT_BIN)'); return; }

  const { server, base } = await startMockServer();
  const work = await mkdtemp(join(tmpdir(), 'ytc-e2e-'));
  const extDir = join(work, 'ext');
  const profile = join(work, 'profile');
  let proc = null;
  let cdp = null;
  try {
    // Test copy of the extension that is also allowed on the mock server's origin.
    for (const f of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.css', 'popup.js', 'icons']) await cp(join(root, f), join(extDir, f), { recursive: true });
    const manifest = JSON.parse(await readFile(join(extDir, 'manifest.json'), 'utf8'));
    manifest.host_permissions.push('http://127.0.0.1/*');
    await writeFile(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // --use-mock-keychain stops macOS from asking for Keychain access on behalf of the test browser.
    proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--user-data-dir=' + profile,
      '--remote-debugging-port=0', '--disable-extensions-except=' + extDir, '--load-extension=' + extDir, 'about:blank'], { stdio: 'ignore' });
    let port = null;
    for (let i = 0; i < 100 && !port; i++) { try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim(); } catch { await sleep(100); } }
    assert.ok(port, 'Chrome did not expose a DevTools port');
    const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
    cdp = await CDP.connect(version.webSocketDebuggerUrl);

    // Chrome derives the id from the resolved path; fall back to discovering the running worker.
    let extId = extensionIdFor(await realpath(extDir));
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const sw = targets.find((x) => x.type === 'service_worker' && x.url.endsWith('/background.js') && x.url.includes(extId))
      || targets.find((x) => x.type === 'service_worker' && x.url.endsWith('/background.js'));
    if (sw) extId = new URL(sw.url).host;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'chrome-extension://' + extId + '/popup.html' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const evalIn = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
      return r.result.value;
    };
    await sleep(300);
    assert.equal(await evalIn('typeof chrome.runtime.sendMessage'), 'function', 'popup did not load as an extension page (manifest problem?)');

    const options = { unsubscribe: true, unlike: true, emptyBuiltin: true, removeSavedPlaylists: true, deleteOwnPlaylists: true, dryRun: false, delayMs: 10,
      waitMs: 3000, loadMoreWaitMs: 500, initialWaitMs: 5000, baseUrl: base };
    const started = await evalIn('chrome.runtime.sendMessage(' + JSON.stringify({ type: 'ytc:start', options }) + ')');
    assert.deepEqual(started, { ok: true });

    let state = null;
    for (let i = 0; i < 300; i++) {
      state = (await evalIn('chrome.runtime.sendMessage({ type: "ytc:get-state" })')).state;
      if (state && !state.running) break;
      await sleep(250);
    }
    assert.ok(state, 'no state recorded');
    assert.equal(state.running, false, 'run did not finish in time; log: ' + JSON.stringify(state.log.slice(-10)));
    assert.equal(state.error, null, 'run error: ' + state.error);

    const logText = state.log.map((l) => l.message).join('\n');
    const byKey = Object.fromEntries(state.results.map((r) => [r.task + (r.name ? ':' + r.name : ''), r]));
    assert.ok(byKey.unsubscribe, 'no unsubscribe result; log:\n' + logText);
    assert.equal(byKey.unsubscribe.error, null, 'unsubscribe error: ' + byKey.unsubscribe.error);
    assert.equal(byKey.unsubscribe.summary.succeeded, 5, 'unsubscribe summary: ' + JSON.stringify(byKey.unsubscribe.summary));
    assert.equal(byKey.unsubscribe.summary.skipped, 1);
    assert.equal(byKey.unsubscribe.summary.failed, 0);

    assert.ok(byKey.playlists, 'no playlists result; log:\n' + logText);
    assert.equal(byKey.playlists.summary.succeeded, 2, 'playlists summary: ' + JSON.stringify(byKey.playlists.summary));
    assert.equal(byKey.playlists.summary.skipped, 2);
    assert.deepEqual(byKey.playlists.summary.fallback.map((f) => f.name), ['Mystery List']);

    const page = byKey['playlist-page:Mystery List'];
    assert.ok(page, 'the fallback playlist page was not visited; log:\n' + logText);
    assert.equal(page.error, null);
    assert.equal(page.summary.succeeded, 1, 'playlist page summary: ' + JSON.stringify(page.summary));
    assert.ok(byKey.unlike, 'no unlike result; log:\n' + logText);
    assert.equal(byKey.unlike.error, null, 'unlike error: ' + byKey.unlike.error);
    assert.equal(byKey.unlike.summary.succeeded, 2, 'unlike summary: ' + JSON.stringify(byKey.unlike.summary));
    for (const [name, n] of [['Sounds', 2]]) {
      const r = byKey['clear-list:' + name];
      assert.ok(r, 'no result for ' + name + '; log:\n' + logText);
      assert.equal(r.error, null, name + ' error: ' + r.error);
      assert.equal(r.summary.succeeded, n, name + ' summary: ' + JSON.stringify(r.summary));
    }
    // Watch later rejects edits that come too fast (409), like YouTube: pass 1 gets two of three
    // videos, the rejected one is picked up by a second pass after a reload.
    const wl = state.results.filter((r) => r.task === 'clear-list' && r.name === 'Watch later');
    assert.equal(wl.length, 2, 'expected two Watch later passes; log:\n' + logText);
    assert.equal(wl[0].pass, 1);
    assert.equal(wl[0].summary.succeeded, 2, 'pass 1: ' + JSON.stringify(wl[0].summary));
    assert.equal(wl[0].summary.failed, 1, 'pass 1: ' + JSON.stringify(wl[0].summary));
    assert.equal(wl[0].summary.rejected.length, 1);
    assert.equal(wl[1].pass, 2);
    assert.equal(wl[1].summary.succeeded, 1, 'pass 2: ' + JSON.stringify(wl[1].summary));
    assert.equal(wl[1].summary.failed, 0, 'pass 2: ' + JSON.stringify(wl[1].summary));
    // Saved Shorts never shows more than one row at a time (a stalled continuation): every pass
    // removes one and reports the rest as remaining; passes continue for as long as they make progress.
    const ys = state.results.filter((r) => r.task === 'clear-list' && r.name === 'Saved Shorts');
    assert.equal(ys.length, 6, 'expected six Saved Shorts passes (one row each); log:\n' + logText);
    ys.forEach((r, i) => {
      assert.equal(r.pass, i + 1);
      assert.equal(r.summary.succeeded, 1, 'pass ' + (i + 1) + ': ' + JSON.stringify(r.summary));
      assert.equal(r.summary.remaining || 0, 5 - i, 'pass ' + (i + 1) + ' remaining: ' + JSON.stringify(r.summary));
    });
    assert.equal(state.results.length, 13);
  } finally {
    if (cdp) cdp.close();
    if (proc) proc.kill('SIGKILL');
    server.close();
    await rm(work, { recursive: true, force: true });
  }
});
