/* YouTube Cleaner - popup. Collects options, starts / stops a run and shows live progress. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TASK_TITLES = { unsubscribe: 'Unsubscribe from all channels', playlists: 'Clean up playlists', unlike: 'Unlike all videos', 'clear-list': 'Empty built-in list', 'playlist-page': 'Playlist' };

  $('version').textContent = 'v' + chrome.runtime.getManifest().version;

  // ---- options persistence (so re-opening the popup keeps your choices) ----
  const OPTS = ['opt-unsubscribe', 'opt-unlike', 'opt-builtin', 'opt-saved', 'opt-own', 'opt-dry', 'opt-delay', 'opt-max', 'opt-only'];
  function readOptions() {
    return {
      unsubscribe: $('opt-unsubscribe').checked,
      unlike: $('opt-unlike').checked,
      emptyBuiltin: $('opt-builtin').checked,
      removeSavedPlaylists: $('opt-saved').checked,
      deleteOwnPlaylists: $('opt-own').checked,
      dryRun: $('opt-dry').checked,
      delayMs: Math.max(0, Number($('opt-delay').value) || 0),
      maxItems: Math.max(0, Number($('opt-max').value) || 0),
      only: $('opt-only').value.split(',').map((s) => s.trim()).filter(Boolean),
    };
  }
  async function restoreOptions() {
    const o = (await chrome.storage.local.get('ytc-options'))['ytc-options'];
    if (!o) return;
    $('opt-unsubscribe').checked = !!o.unsubscribe;
    $('opt-unlike').checked = !!o.unlike;
    $('opt-builtin').checked = !!o.emptyBuiltin;
    $('opt-saved').checked = !!o.removeSavedPlaylists;
    $('opt-own').checked = !!o.deleteOwnPlaylists;
    $('opt-dry').checked = o.dryRun !== false;
    if (o.delayMs >= 0) $('opt-delay').value = o.delayMs;
    if (o.maxItems >= 0) $('opt-max').value = o.maxItems;
    if (Array.isArray(o.only)) $('opt-only').value = o.only.join(', ');
  }
  function saveOptions() { chrome.storage.local.set({ 'ytc-options': readOptions() }); }

  function refreshStartButton() {
    const o = readOptions();
    const anything = o.unsubscribe || o.unlike || o.emptyBuiltin || o.removeSavedPlaylists || o.deleteOwnPlaylists;
    $('confirm-row').hidden = o.dryRun;
    const confirmed = o.dryRun || $('opt-confirm').checked;
    $('start').disabled = !anything || !confirmed;
    $('start').textContent = o.dryRun ? 'Start dry run' : 'Start (make changes)';
  }
  OPTS.concat(['opt-confirm']).forEach((id) => $(id).addEventListener('change', () => { saveOptions(); refreshStartButton(); }));

  // ---- rendering ----
  function fmtSummary(s) {
    if (!s) return '';
    return s.succeeded + ' done, ' + s.failed + ' failed, ' + s.skipped + ' skipped' + (s.stopped ? ' (stopped early)' : '');
  }

  function render(state) {
    const hasRun = !!state && (state.running || state.results.length || state.log.length);
    $('setup').hidden = hasRun;
    $('status').hidden = !hasRun;
    if (!hasRun) { refreshStartButton(); return; }

    const dry = state.options && state.options.dryRun ? ' (dry run)' : '';
    if (state.running) {
      $('state-line').textContent = (state.stopRequested ? 'Stopping' : 'Running') + dry + '...';
    } else {
      $('state-line').textContent = (state.error ? 'Stopped: ' + state.error : 'Finished' + dry + '.');
    }

    const cur = state.current;
    if (cur) {
      const p = cur.progress;
      $('current').textContent = TASK_TITLES[cur.task] + (cur.name ? ': ' + cur.name : '') +
        (p ? ' - ' + p.processed + ' seen, ' + p.succeeded + ' done, ' + p.failed + ' failed, ' + p.skipped + ' skipped' : ' - ' + (cur.status === 'loading' ? 'loading page...' : 'working...'));
    } else {
      $('current').textContent = '';
    }

    const res = $('results');
    res.innerHTML = '';
    const pageResults = state.results.filter((r) => r.task === 'playlist-page');
    state.results.filter((r) => r.task !== 'playlist-page').forEach((r) => {
      const div = document.createElement('div');
      div.className = 'result';
      div.innerHTML = '<div class="title"></div><div class="detail"></div>';
      div.querySelector('.title').textContent = (TASK_TITLES[r.task] || r.task) + (r.name ? ': ' + r.name : '') + (r.pass > 1 ? ' (pass ' + r.pass + ')' : '');
      const d = div.querySelector('.detail');
      if (r.error) { d.textContent = r.error; d.className = 'detail err'; }
      else d.textContent = fmtSummary(r.summary);
      res.appendChild(div);
    });
    if (pageResults.length) {
      const div = document.createElement('div');
      div.className = 'result';
      const ok = pageResults.filter((r) => (r.summary && r.summary.succeeded) || r.note).length;
      const bad = pageResults.filter((r) => r.error || (r.summary && r.summary.failed)).length;
      div.innerHTML = '<div class="title">Playlists handled on their own page</div><div class="detail"></div>';
      div.querySelector('.detail').textContent = pageResults.length + ' visited, ' + ok + ' done, ' + bad + ' failed';
      res.appendChild(div);
    }

    const log = $('log');
    log.innerHTML = '';
    state.log.slice(-40).forEach((l) => {
      const line = document.createElement('div');
      line.className = l.level || 'info';
      line.textContent = l.message;
      log.appendChild(line);
    });
    log.scrollTop = log.scrollHeight;

    $('stop').hidden = !state.running;
    $('reset').hidden = state.running;
  }

  async function load() {
    const r = await chrome.runtime.sendMessage({ type: 'ytc:get-state' });
    render(r && r.state);
  }

  // ---- actions ----
  $('start').addEventListener('click', async () => {
    $('setup-error').hidden = true;
    $('start').disabled = true;
    const r = await chrome.runtime.sendMessage({ type: 'ytc:start', options: readOptions() });
    if (!r || !r.ok) {
      $('setup-error').textContent = (r && r.error) || 'Could not start.';
      $('setup-error').hidden = false;
      refreshStartButton();
      return;
    }
    await load();
  });
  $('stop').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'ytc:stop' }); await load(); });
  $('reset').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'ytc:reset' }); await load(); });

  chrome.storage.session.onChanged.addListener((changes) => { if (changes['ytc-state']) render(changes['ytc-state'].newValue); });

  restoreOptions().then(() => { refreshStartButton(); return load(); });
})();
