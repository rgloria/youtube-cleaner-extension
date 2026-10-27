/*
 * YouTube Cleaner - background service worker.
 *
 * Orchestrates a run: opens a YouTube tab, navigates it to each page that needs
 * work, injects content.js and tells it which task to perform, then moves on
 * when the content script reports back. All state lives in
 * chrome.storage.session so the worker can be suspended and resumed by Chrome
 * at any time without losing track of the run.
 */

const STATE_KEY = 'ytc-state';
const WATCHDOG = 'ytc-watchdog';
const STALL_MS = 4 * 60 * 1000;

const DEFAULT_BASE = 'https://www.youtube.com';
const TASK_PATHS = { unsubscribe: '/feed/channels', playlists: '/feed/playlists', unlike: '/playlist?list=LL' };
// Built-in lists that cannot be deleted, only emptied (Liked videos is handled by the "unlike" task).
const BUILTIN_LISTS = [['WL', 'Watch later'], ['YS', 'Saved Shorts'], ['SS', 'Sounds']];
// A list is reloaded and run again while removals are still being rejected or its header still shows
// videos, for as long as the passes keep making progress (plus a couple of idle ones), up to a hard cap.
const MAX_IDLE_PASSES = 2;
const MAX_PASSES = 200;

// The tests point this at a local mock server; normal use always means youtube.com.
function baseOrigin(options) {
  try { return new URL((options && options.baseUrl) || DEFAULT_BASE).origin; } catch (e) { return DEFAULT_BASE; }
}

// ---------------------------------------------------------------- state helpers
async function getState() {
  const o = await chrome.storage.session.get(STATE_KEY);
  return o[STATE_KEY] || null;
}

// Every mutation goes through this queue so overlapping messages (log,
// progress, done) cannot overwrite each other's changes.
let chain = Promise.resolve();
function withState(fn) {
  const p = chain.then(async () => {
    const state = await getState();
    const out = await fn(state);
    const next = out === undefined ? state : out;
    await chrome.storage.session.set({ [STATE_KEY]: next });
    return next;
  });
  chain = p.catch(() => {});
  return p;
}

function appendLog(state, message, level) {
  if (!state) return;
  state.log.push({ t: Date.now(), message, level: level || 'info' });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

function contentOptions(o) {
  return {
    dryRun: !!o.dryRun,
    deleteOwnPlaylists: !!o.deleteOwnPlaylists,
    removeSavedPlaylists: !!o.removeSavedPlaylists,
    delayMs: Number(o.delayMs) >= 0 ? Number(o.delayMs) : undefined,
    maxItems: Number(o.maxItems) > 0 ? Number(o.maxItems) : 0,
    waitMs: Number(o.waitMs) > 0 ? Number(o.waitMs) : undefined,
    loadMoreWaitMs: Number(o.loadMoreWaitMs) > 0 ? Number(o.loadMoreWaitMs) : undefined,
    initialWaitMs: Number(o.initialWaitMs) > 0 ? Number(o.initialWaitMs) : undefined,
    only: Array.isArray(o.only) ? o.only : (o.only ? String(o.only).split(',').map((s) => s.trim()).filter(Boolean) : []),
  };
}

function urlMatches(actual, expected) {
  try {
    const a = new URL(actual);
    const e = new URL(expected);
    if (a.origin !== e.origin || a.pathname.replace(/\/$/, '') !== e.pathname.replace(/\/$/, '')) return false;
    const list = e.searchParams.get('list');
    return !list || a.searchParams.get('list') === list;
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------- run lifecycle
async function start(options) {
  await withState(async (existing) => {
    if (existing && existing.running) throw new Error('A run is already in progress.');
    const base = baseOrigin(options);
    const queue = [];
    if (options.unsubscribe) queue.push({ task: 'unsubscribe', url: base + TASK_PATHS.unsubscribe });
    if (options.removeSavedPlaylists || options.deleteOwnPlaylists) queue.push({ task: 'playlists', url: base + TASK_PATHS.playlists });
    if (options.unlike) queue.push({ task: 'unlike', url: base + TASK_PATHS.unlike });
    if (options.emptyBuiltin) for (const [id, name] of BUILTIN_LISTS) queue.push({ task: 'clear-list', url: base + '/playlist?list=' + id, name });
    if (!queue.length) throw new Error('Nothing selected.');

    const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    const state = {
      running: true, startedAt: Date.now(), finishedAt: null, options, tabId: tab.id, windowId: tab.windowId,
      queue, current: null, awaitingLoad: false, lastActivity: Date.now(), results: [], log: [], error: null, stopRequested: false,
    };
    appendLog(state, (options.dryRun ? '[DRY RUN] ' : '') + 'Starting ' + queue.length + ' task(s).');
    await chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
    await advance(state);
    return state;
  });
}

// Moves to the next queued task, or finishes the run. Mutates `state`.
async function advance(state) {
  const next = state.stopRequested ? null : state.queue.shift();
  if (!next) {
    state.running = false;
    state.current = null;
    state.awaitingLoad = false;
    state.finishedAt = Date.now();
    appendLog(state, state.stopRequested ? 'Stopped.' : 'All done.');
    await chrome.alarms.clear(WATCHDOG);
    return;
  }
  state.current = { task: next.task, url: next.url, name: next.name || null, pass: next.pass || 1, idle: next.idle || 0, status: 'loading', startedAt: Date.now(), progress: null };
  state.awaitingLoad = true;
  state.lastActivity = Date.now();
  appendLog(state, 'Opening ' + (next.name ? 'playlist "' + next.name + '"' : next.url) + (next.pass > 1 ? ' again (pass ' + next.pass + ')' : '') + '...');
  try {
    await chrome.tabs.update(state.tabId, { url: next.url, active: true });
  } catch (e) {
    state.running = false;
    state.current = null;
    state.awaitingLoad = false;
    state.finishedAt = Date.now();
    state.error = 'The YouTube tab is gone (' + (e && e.message || e) + ').';
    appendLog(state, state.error, 'error');
    await chrome.alarms.clear(WATCHDOG);
  }
}

async function finishCurrent(state, result) {
  if (state.current) { result.pass = state.current.pass || 1; result.url = state.current.url; result.idle = state.current.idle || 0; }
  state.results.push(result);
  if (result.error) appendLog(state, 'Task ended with an error: ' + result.error, 'error');
  // YouTube rejects playlist edits that come too fast; the rows are gone from the page but the videos
  // are still in the list, so reload the list and go again.
  // The same goes for a run that ended while the list header still shows videos (YouTube stopped
  // serving rows).
  const rejected = result.summary && Array.isArray(result.summary.rejected) ? result.summary.rejected.length : 0;
  const remaining = result.summary && Number(result.summary.remaining) > 0 ? Number(result.summary.remaining) : 0;
  const why = rejected ? rejected + ' removal(s) were rejected by YouTube' : remaining ? 'the list still shows ' + remaining + ' video(s)' : '';
  const idle = result.summary && result.summary.succeeded > 0 ? 0 : (result.idle || 0) + 1;
  if (why && !state.stopRequested && result.pass < MAX_PASSES && idle <= MAX_IDLE_PASSES) {
    state.queue.unshift({ task: result.task, url: result.url, name: result.name, pass: result.pass + 1, idle });
    appendLog(state, why + '; reloading the list for another pass.');
  } else if (why) {
    appendLog(state, why + ' after ' + result.pass + ' pass(es) with no further progress; run again later to finish.', 'error');
  }
  const fb = result.summary && result.task === 'playlists' ? result.summary.fallback : null;
  if (Array.isArray(fb) && fb.length && !state.stopRequested) {
    state.queue.unshift(...fb.map((f) => ({ task: 'playlist-page', url: f.url, name: f.name })));
    appendLog(state, fb.length + ' playlist(s) had no delete / remove option in the list view; visiting each one.');
  }
  state.current = null;
  await advance(state);
}

async function launch(state) {
  try {
    const tab = await chrome.tabs.get(state.tabId);
    const expected = new URL(state.current.url);
    let actual = null;
    try { actual = new URL(tab.url || ''); } catch (e) { actual = null; }
    const stillOnTheWay = !actual || actual.href === 'about:blank' || (actual.origin === expected.origin && !urlMatches(tab.url, state.current.url));
    if (stillOnTheWay) {
      // That "page loaded" event was for the blank starter tab or the previous
      // page; keep waiting for the navigation we asked for.
      state.awaitingLoad = true;
      state.current.status = 'loading';
      return;
    }
    if (actual.origin !== expected.origin) {
      throw new Error('the tab ended up on ' + tab.url + ' (are you signed in to YouTube?)');
    }
    await chrome.scripting.executeScript({ target: { tabId: state.tabId }, files: ['content.js'] });
    const resp = await chrome.tabs.sendMessage(state.tabId, { type: 'ytc:run', task: state.current.task, options: contentOptions(state.options) });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'the page did not accept the task');
    state.current.status = 'running';
    state.lastActivity = Date.now();
  } catch (e) {
    await finishCurrent(state, { task: state.current.task, name: state.current.name, error: 'Could not start on the page: ' + (e && e.message || e) });
  }
}

async function stopRun() {
  await withState(async (s) => {
    if (!s || !s.running) return;
    s.stopRequested = true;
    s.queue = [];
    appendLog(s, 'Stop requested; finishing the current item...');
    try { await chrome.tabs.sendMessage(s.tabId, { type: 'ytc:stop' }); } catch (e) { /* nothing running in the tab */ }
    if (s.awaitingLoad || !s.current) await advance(s);
  });
}

// ---------------------------------------------------------------- browser events
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  withState(async (s) => {
    if (!s || !s.running || tabId !== s.tabId) return;
    if (s.awaitingLoad) {
      s.awaitingLoad = false;
      await launch(s);
      return;
    }
    // A fresh page load while a playlist page is being processed means YouTube
    // navigated away (it does that right after a playlist is deleted).
    if (s.current && s.current.task === 'playlist-page' && s.current.status === 'running') {
      appendLog(s, 'The page navigated away; treating "' + (s.current.name || 'playlist') + '" as handled.');
      await finishCurrent(s, { task: 'playlist-page', name: s.current.name, summary: null, note: 'page navigated away before reporting' });
    }
  }).catch((e) => console.error('[YouTube Cleaner]', e));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  withState(async (s) => {
    if (!s || !s.running || tabId !== s.tabId) return;
    s.running = false;
    s.current = null;
    s.awaitingLoad = false;
    s.finishedAt = Date.now();
    s.error = 'The YouTube tab was closed, so the run stopped.';
    appendLog(s, s.error, 'error');
    await chrome.alarms.clear(WATCHDOG);
  }).catch((e) => console.error('[YouTube Cleaner]', e));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCHDOG) return;
  (async () => {
    const s = await getState();
    if (!s || !s.running) { await chrome.alarms.clear(WATCHDOG); return; }
    if (Date.now() - s.lastActivity < STALL_MS) return;
    let alive = false;
    try {
      const r = await chrome.tabs.sendMessage(s.tabId, { type: 'ytc:ping' });
      alive = !!(r && r.running);
    } catch (e) { alive = false; }
    await withState(async (st) => {
      if (!st || !st.running) return;
      if (alive) { st.lastActivity = Date.now(); return; }
      appendLog(st, 'No progress for several minutes and the page is not responding; moving on.', 'error');
      const cur = st.current || {};
      st.current = null;
      st.awaitingLoad = false;
      await finishCurrent(st, { task: cur.task || 'unknown', name: cur.name || null, error: 'timed out' });
    });
  })().catch((e) => console.error('[YouTube Cleaner]', e));
});

// ---------------------------------------------------------------- messages (popup + content script)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((r) => sendResponse(r || { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

async function handleMessage(msg, sender) {
  const type = msg && msg.type;
  switch (type) {
    case 'ytc:start':
      await start(msg.options || {});
      return { ok: true };
    case 'ytc:stop':
      await stopRun();
      return { ok: true };
    case 'ytc:get-state':
      return { ok: true, state: await getState() };
    case 'ytc:reset':
      await withState(async (s) => {
        if (s && s.running) throw new Error('A run is still in progress.');
        return null;
      });
      return { ok: true };
    case 'ytc:log':
      await withState(async (s) => {
        if (!s || !sender.tab || sender.tab.id !== s.tabId) return;
        appendLog(s, msg.message, msg.level);
        s.lastActivity = Date.now();
      });
      return { ok: true };
    case 'ytc:progress':
      await withState(async (s) => {
        if (!s || !s.current || !sender.tab || sender.tab.id !== s.tabId) return;
        s.current.progress = msg.info;
        s.lastActivity = Date.now();
      });
      return { ok: true };
    case 'ytc:done':
      await withState(async (s) => {
        if (!s || !s.running || !s.current || !sender.tab || sender.tab.id !== s.tabId) return;
        // Ignore a late report from a page we have already moved on from.
        if (s.current.status !== 'running' || msg.task !== s.current.task) return;
        await finishCurrent(s, { task: msg.task, name: s.current.name, summary: msg.summary || null, error: msg.error || null });
      });
      return { ok: true };
    default:
      return { ok: false, error: 'Unknown message type: ' + type };
  }
}
