import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// The fixture is served over HTTP so the mock can make real /youtubei/v1/... requests; the status
// each one gets back is chosen by the mock (?mock_status=...), which is how YouTube's accept /
// reject behaviour is simulated.
let server = null;
let base = '';
before(async () => {
  const types = { '.js': 'text/javascript', '.html': 'text/html' };
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/youtubei/v1/')) {
      const status = Number(url.searchParams.get('mock_status') || 200);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200 ? '{"status":"STATUS_SUCCEEDED"}' : '{"error":{"code":' + status + ',"status":"ABORTED"}}');
      return;
    }
    const file = join(root, url.pathname);
    if (!file.startsWith(root) || !types[extname(file)]) { res.writeHead(404); res.end('not found'); return; }
    try { const body = await readFile(file); res.writeHead(200, { 'content-type': types[extname(file)] }); res.end(body); }
    catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; resolve(); }));
});
after(() => new Promise((resolve) => server.close(resolve)));

async function runCase(name) {
  const profile = await mkdtemp(join(tmpdir(), 'ytc-'));
  const url = base + '/test/fixture.html?case=' + encodeURIComponent(name);
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, '--virtual-time-budget=120000', '--dump-dom', url,
  ];
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(CHROME, args, { maxBuffer: 64 * 1024 * 1024, timeout: 90000 }, (err, out) => (err ? reject(err) : resolve(out)));
    });
    const m = stdout.match(/<pre id="ytc-result">([^<]*)<\/pre>/);
    assert.ok(m, 'fixture did not publish a result');
    const json = decodeURIComponent(escape(Buffer.from(m[1], 'base64').toString('binary')));
    const result = JSON.parse(json);
    assert.equal(result.error, undefined, 'fixture error: ' + result.error);
    return result;
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

const names = (items, status) => items.filter((i) => i.status === status).map((i) => i.name);

test('unsubscribes from every subscribed channel, including ones loaded by scrolling', async () => {
  const r = await runCase('unsubscribe-basic');
  assert.deepEqual(r.events.unsubscribed.sort(), ['Alpha Channel', 'Beta Builds', 'Delta Docs', 'Epsilon Eats', 'Zeta Zone']);
  assert.equal(r.summary.task, 'unsubscribe');
  assert.equal(r.summary.succeeded, 5);
  assert.equal(r.summary.failed, 0);
  assert.deepEqual(names(r.summary.items, 'skipped'), ['Gamma Games']);
  assert.ok(r.dom.subscribeButtons.every((b) => b.text === 'Subscribe'), 'every button should read Subscribe');
  assert.equal(r.events.resubscribed, undefined, 'must never click a plain Subscribe button');
  assert.equal(r.dom.dropdownOpen, false);
  assert.equal(r.dom.dialogOpen, false);
  assert.equal(r.dom.continuationPresent, false, 'should have scrolled until everything loaded');
});

test('dry run opens menus but changes nothing', async () => {
  const r = await runCase('unsubscribe-dry-run');
  assert.deepEqual(r.events.unsubscribed, []);
  assert.equal(r.summary.dryRun, true);
  assert.equal(r.summary.succeeded, 0);
  assert.equal(names(r.summary.items, 'dry-run').length, 5);
  const alpha = r.summary.items.find((i) => i.name === 'Alpha Channel');
  assert.ok(alpha.menuLabels.includes('Unsubscribe'), 'dry run should report the menu labels it saw');
  assert.ok(r.dom.subscribeButtons.filter((b) => b.text === 'Subscribed').length === 5);
  assert.equal(r.dom.dropdownOpen, false, 'menus must be closed again');
});

test('a channel whose menu never opens is reported as failed and the run continues', async () => {
  const r = await runCase('unsubscribe-broken-menu');
  assert.deepEqual(r.events.unsubscribed.sort(), ['Fine One', 'Fine Two']);
  assert.deepEqual(names(r.summary.items, 'failed'), ['Broken One']);
  assert.equal(r.summary.failed, 1);
  assert.equal(r.summary.succeeded, 2);
});

test('handles channels that unsubscribe without a confirmation dialog', async () => {
  const r = await runCase('unsubscribe-no-dialog');
  assert.deepEqual(r.events.unsubscribed.sort(), ['Dialog One', 'Direct One']);
  assert.equal(r.summary.failed, 0);
});

test('never clicks the notification bell, only the main Subscribed button', async () => {
  const r = await runCase('unsubscribe-basic');
  assert.equal(r.events.bellClicks, undefined, 'bell toggle was clicked: ' + JSON.stringify(r.events.bellClicks));
  assert.ok(r.dom.subscribeButtons.every((b) => b.bell === false), 'bells should be gone after unsubscribing');
});

test('handles a Subscribed button that opens the confirmation dialog directly (no menu)', async () => {
  const r = await runCase('unsubscribe-direct-dialog');
  assert.deepEqual(r.events.unsubscribed.sort(), ['Direct Dialog', 'Menu One']);
  assert.equal(r.summary.failed, 0);
  assert.equal(r.dom.dialogOpen, false);
});

test('never treats sidebar entries as menu items, even one named "Unsubscribe"', async () => {
  const r = await runCase('unsubscribe-direct-dialog');
  assert.equal(r.events.guideClicks, undefined, 'sidebar entry was clicked: ' + JSON.stringify(r.events.guideClicks));
  const item = r.summary.items.find((i) => i.name === 'Direct Dialog');
  assert.deepEqual(item.menuLabels, [], 'sidebar labels leaked into the menu label list');
  assert.match(item.dialogText || '', /Unsubscribe from Direct Dialog\?/);
});

test('dry run cancels a directly opened confirmation dialog and changes nothing', async () => {
  const r = await runCase('unsubscribe-dry-run-direct');
  assert.deepEqual(r.events.unsubscribed, []);
  assert.equal(r.summary.items[0].status, 'dry-run');
  assert.equal(r.dom.dialogOpen, false, 'the dialog must be cancelled');
  assert.equal(r.dom.subscribeButtons[0].text, 'Subscribed');
});

test('stops promptly when the reporter asks to stop', async () => {
  const r = await runCase('unsubscribe-stop');
  assert.equal(r.events.unsubscribed.length, 1);
  assert.equal(r.summary.stopped, true);
  assert.equal(r.summary.succeeded, 1);
});

test('removes saved playlists only, skipping own and system playlists and ignoring videos', async () => {
  const r = await runCase('playlists-saved-only');
  assert.deepEqual(r.events.removed.sort(), ['Cool Saved List', 'Late Saved']);
  assert.deepEqual(r.events.deleted, []);
  assert.deepEqual(names(r.summary.items, 'done').sort(), ['Cool Saved List', 'Late Saved']);
  assert.deepEqual(names(r.summary.items, 'skipped').sort(), ['My Mix', 'Old Style Own', 'Watch later']);
  assert.ok(!r.summary.items.some((i) => i.name === 'Some Video'), 'video items are not playlists');
  const own = r.summary.items.find((i) => i.name === 'My Mix');
  assert.match(own.reason, /own playlist/i);
  assert.deepEqual(r.dom.playlistTitles.sort(), ['My Mix', 'Old Style Own', 'Some Video', 'Watch later']);
  assert.equal(r.dom.dropdownOpen, false);
});

test('deletes own playlists (with confirmation) and removes saved ones when both are enabled', async () => {
  const r = await runCase('playlists-own-and-saved');
  assert.deepEqual(r.events.deleted.sort(), ['My Mix', 'Old Style Own']);
  assert.deepEqual(r.events.removed.sort(), ['Cool Saved List', 'Late Saved']);
  assert.equal(r.summary.succeeded, 4);
  assert.deepEqual(names(r.summary.items, 'skipped'), ['Watch later']);
  assert.deepEqual(r.dom.playlistTitles.sort(), ['Some Video', 'Watch later']);
  assert.equal(r.dom.dialogOpen, false);
});

test('playlist dry run reports menu labels and deletes nothing', async () => {
  const r = await runCase('playlists-dry-run');
  assert.deepEqual(r.events.deleted, []);
  assert.deepEqual(r.events.removed, []);
  assert.equal(names(r.summary.items, 'dry-run').length, 4);
  const saved = r.summary.items.find((i) => i.name === 'Cool Saved List');
  assert.ok(saved.menuLabels.includes('Remove from library'));
  assert.deepEqual(r.dom.playlistTitles.sort(), ['Cool Saved List', 'Late Saved', 'My Mix', 'Old Style Own', 'Some Video', 'Watch later']);
});

test('playlists with no usable grid menu are listed for the page-by-page fallback', async () => {
  const r = await runCase('playlists-fallback-list');
  assert.deepEqual(r.events.removed, ['Cool Saved List']);
  const mystery = r.summary.items.find((i) => i.name === 'Mystery List');
  assert.equal(mystery.status, 'skipped');
  const noMenu = r.summary.items.find((i) => i.name === 'Saved Without Menu');
  assert.equal(noMenu.status, 'skipped');
  // the fallback URL is built on the page's own origin (the mock server here, youtube.com for real)
  assert.deepEqual(r.summary.fallback, [
    { id: 'PLmystery', name: 'Mystery List', url: base + '/playlist?list=PLmystery' },
    { id: 'PLnomenu', name: 'Saved Without Menu', url: base + '/playlist?list=PLnomenu' },
  ]);
});

test('on a playlist page, deletes an own playlist through the header menu and confirmation', async () => {
  const r = await runCase('playlist-page-own-delete');
  assert.deepEqual(r.events.deleted, ['Road Trip']);
  assert.equal(r.summary.task, 'playlist-page');
  assert.equal(r.summary.succeeded, 1);
  assert.equal(r.summary.items[0].name, 'Road Trip');
  assert.equal(r.events.videoRemoved, undefined, 'must not touch the video rows');
  assert.equal(r.dom.dialogOpen, false);
});

test('on a playlist page, leaves an own playlist alone when deleting own playlists is off', async () => {
  const r = await runCase('playlist-page-own-disabled');
  assert.deepEqual(r.events.deleted, []);
  assert.equal(r.summary.items[0].status, 'skipped');
  assert.match(r.summary.items[0].reason, /own playlist/i);
  assert.equal(r.dom.dropdownOpen, false);
});

test('on a playlist page, a dry run reports the plan and deletes nothing', async () => {
  const r = await runCase('playlist-page-own-dry-run');
  assert.deepEqual(r.events.deleted, []);
  assert.equal(r.summary.items[0].status, 'dry-run');
  assert.ok(r.summary.items[0].menuLabels.includes('Delete playlist'));
});

test('on a playlist page, removes a saved playlist via the header bookmark toggle', async () => {
  const r = await runCase('playlist-page-saved-toggle');
  assert.deepEqual(r.events.removed, ['Study Beats']);
  assert.equal(r.events.resaved, undefined, 'must never click a "Save playlist" button');
  assert.equal(r.summary.succeeded, 1);
});

test('on a playlist page, removes a saved playlist via the header menu when there is no toggle', async () => {
  const r = await runCase('playlist-page-saved-menu');
  assert.deepEqual(r.events.removed, ['Study Beats']);
  assert.equal(r.summary.succeeded, 1);
});

test('on a playlist page, leaves a saved playlist alone when removing saved playlists is off', async () => {
  const r = await runCase('playlist-page-saved-disabled');
  assert.deepEqual(r.events.removed, []);
  assert.equal(r.summary.items[0].status, 'skipped');
});

test('removes every video from Liked videos, including rows loaded by scrolling without a spinner', async () => {
  const r = await runCase('unlike-basic');
  assert.deepEqual(r.events.unliked.sort(), ['Liked Five', 'Liked Four', 'Liked One', 'Liked Three', 'Liked Two']);
  assert.equal(r.events.misclicks, undefined, 'clicked a wrong menu item: ' + JSON.stringify(r.events.misclicks));
  assert.equal(r.summary.task, 'unlike');
  assert.equal(r.summary.succeeded, 5);
  assert.equal(r.summary.failed, 0);
  assert.deepEqual(r.dom.likedRows, []);
  assert.equal(r.dom.dropdownOpen, false);
});

test('when YouTube rejects playlist edits that come too fast (409), the run reports them as failed, lists them for a second pass and slows down', async () => {
  const r = await runCase('clear-watch-later-rate-limited');
  const accepted = (r.events.removedFromList || {}).WL || [];
  const rejected = r.events.rejected || [];
  assert.ok(rejected.length >= 1, 'the mock should have rejected at least one fast edit; log: ' + JSON.stringify(r.log));
  assert.equal(r.summary.succeeded, accepted.length, 'succeeded must equal what YouTube accepted; log: ' + JSON.stringify(r.log));
  assert.equal(r.summary.failed, rejected.length, 'failed must equal what YouTube rejected; log: ' + JSON.stringify(r.log));
  assert.deepEqual(r.summary.items.filter((i) => i.rejected).map((i) => i.name).sort(), rejected.slice().sort());
  assert.deepEqual((r.summary.rejected || []).map((x) => x.name).sort(), rejected.slice().sort(), 'summary.rejected should list the videos still in the list');
  assert.ok(r.summary.items.filter((i) => i.rejected).every((i) => /rejected|409/i.test(i.reason)), JSON.stringify(r.summary.items.map((i) => i.reason)));
  assert.equal(rejected.length, 1, 'after the first rejection the run must slow down enough that no further edit is rejected; rejected: ' + JSON.stringify(rejected));
  assert.equal(accepted.length, 5);
  assert.ok(r.log.some((l) => /slow/i.test(l)), 'should log that it slowed down: ' + JSON.stringify(r.log));
});

test('waits for a slow removal request (YouTube takes 3s+ under load) instead of giving up on the status signal', async () => {
  const r = await runCase('unlike-slow-api');
  assert.equal(r.summary.succeeded, 3);
  assert.equal(r.summary.failed, 0);
  assert.ok(r.summary.items.every((i) => /confirmed/.test(i.reason)), 'every removal should have been confirmed by its (slow) request: ' + JSON.stringify(r.summary.items.map((i) => i.reason)));
});

test('when the page stops serving rows before the list is empty, the run reports how many the header still shows', async () => {
  const r = await runCase('clear-list-stalled-rows');
  assert.deepEqual(((r.events.removedFromList || {}).WL || []).sort(), ['WL One', 'WL Three', 'WL Two']);
  assert.equal(r.summary.succeeded, 3);
  assert.equal(r.summary.remaining, 2, 'summary.remaining should be what the header still shows: ' + JSON.stringify(r.summary));
  assert.ok(r.log.some((l) => /still shows 2/.test(l)), JSON.stringify(r.log));
});

test('shows hidden unavailable (deleted / private) videos through the header menu and removes them too', async () => {
  const r = await runCase('clear-watch-later-unavailable');
  assert.equal(r.events.showUnavailableClicks, 1, 'should have clicked "Show unavailable videos" once; log: ' + JSON.stringify(r.log));
  assert.deepEqual(((r.events.removedFromList || {}).WL || []).sort(), ['WL One', 'WL Two', '[Deleted video]', '[Private video]']);
  assert.equal(r.summary.succeeded, 4);
  assert.equal(r.summary.failed, 0);
  assert.ok(!r.summary.remaining, 'nothing should remain: ' + JSON.stringify(r.summary));
  assert.ok(r.log.some((l) => /unavailable/i.test(l)), JSON.stringify(r.log));
  assert.equal(r.dom.dropdownOpen, false);
});

test('an accepted removal is reported as confirmed even on a list whose rows never refresh', async () => {
  const r = await runCase('unlike-static-rows-confirmed');
  assert.equal(r.summary.succeeded, 3);
  assert.equal(r.summary.failed, 0);
  assert.ok(r.summary.items.every((i) => /confirmed/.test(i.reason) && !/refresh to verify/.test(i.reason)), JSON.stringify(r.summary.items.map((i) => i.reason)));
  assert.ok(r.elapsedMs < 20000, 'three confirmed removals plus the end-of-list scan took ' + r.elapsedMs + 'ms');
});

test('on a list whose rows never refresh (Liked videos), a removal is done once the menu has closed plus a short grace period, not after the full wait', async () => {
  const r = await runCase('unlike-static-rows');
  assert.deepEqual(r.events.unliked.sort(), ['Liked Five', 'Liked Four', 'Liked One', 'Liked Six', 'Liked Three', 'Liked Two']);
  assert.equal(r.summary.succeeded, 6);
  assert.equal(r.summary.failed, 0);
  assert.equal(r.events.duplicateRemovals, undefined, 'a row that stays on the page must not be removed twice');
  assert.ok(r.summary.items.every((i) => /refresh to verify/.test(i.reason)), 'should say the rows were not seen to go: ' + JSON.stringify(r.summary.items.map((i) => i.reason)));
  const ms = r.summary.items.map((i) => i.ms);
  assert.ok(ms.slice(0, 3).every((t) => t < 9500), 'the first rows wait for a removal request that never comes (max 8s): ' + JSON.stringify(ms));
  assert.ok(ms.slice(3).every((t) => t < 2500), 'once the signal is given up, a row must only cost the grace period, not the full 6s wait: ' + JSON.stringify(ms));
  assert.equal(r.dom.dropdownOpen, false);
});

test('unlike dry run reports the menu labels and removes nothing', async () => {
  const r = await runCase('unlike-dry-run');
  assert.deepEqual(r.events.unliked, []);
  assert.equal(names(r.summary.items, 'dry-run').length, 2);
  assert.ok(r.summary.items[0].menuLabels.includes('Remove from Liked videos'));
  assert.deepEqual(r.dom.likedRows, ['Liked One', 'Liked Two']);
  assert.equal(r.dom.dropdownOpen, false);
});

test('unlike stops promptly when asked', async () => {
  const r = await runCase('unlike-stop');
  assert.equal(r.events.unliked.length, 1);
  assert.equal(r.summary.stopped, true);
});

test('the "only" filter limits a playlists run to matching ids and leaves everything else untouched', async () => {
  const r = await runCase('playlists-only');
  assert.deepEqual(r.events.removed, ['Cool Saved List']);
  assert.deepEqual(r.events.deleted, []);
  assert.equal(r.summary.processed, 1);
  assert.ok(r.summary.filteredOut >= 4, 'filteredOut should count the ignored items, got ' + r.summary.filteredOut);
  assert.deepEqual(r.dom.playlistTitles.sort(), ['Late Saved', 'My Mix', 'Old Style Own', 'Some Video', 'Watch later']);
});

test('the "only" filter matches channel names case-insensitively', async () => {
  const r = await runCase('unsubscribe-only');
  assert.deepEqual(r.events.unsubscribed, ['Beta Builds']);
  assert.equal(r.summary.processed, 1);
});

test('deletes every own playlist even though YouTube recycles tiles instead of removing them', async () => {
  const r = await runCase('playlists-recycled');
  assert.deepEqual(r.events.deleted.sort(), ['Alpha Own', 'Bravo Own', 'Delta Own']);
  assert.deepEqual(r.events.removed, ['Charlie Saved']);
  assert.equal(r.summary.succeeded, 4, JSON.stringify(r.summary.items));
  assert.equal(r.summary.failed, 0);
  assert.ok(!r.summary.items.some((i) => /unknown/i.test(i.name)), 'no phantom items: ' + JSON.stringify(r.summary.items.map((i) => i.name)));
  assert.ok(!r.summary.items.some((i) => /did not disappear|refresh/i.test(i.reason || '')), 'completion must be detected: ' + JSON.stringify(r.summary.items.map((i) => i.reason)));
  assert.deepEqual(r.dom.playlistTitles, ['Watch later']);
});

test('removes every liked video even though YouTube recycles rows instead of removing them', async () => {
  const r = await runCase('unlike-recycled');
  assert.deepEqual(r.events.unliked.sort(), ['Liked Four', 'Liked One', 'Liked Three', 'Liked Two']);
  assert.equal(r.summary.succeeded, 4);
  assert.ok(!r.summary.items.some((i) => /still shown|refresh/i.test(i.reason || '')), 'completion must be detected: ' + JSON.stringify(r.summary.items.map((i) => i.reason)));
  assert.deepEqual(r.dom.likedRows, []);
});

test('on an old-style playlist page (saved course), removes it via the "Remove from Your courses" toggle despite decoy headers', async () => {
  const r = await runCase('playlist-page-course');
  assert.deepEqual(r.events.removed, ['AWS Course']);
  assert.equal(r.summary.items[0].status, 'done', JSON.stringify(r.summary.items[0]));
  assert.equal(r.summary.items[0].name, 'AWS Course');
});

test('Saved Shorts, Sounds and Liked videos are reported as undeletable built-in lists, not retried on their pages', async () => {
  const r = await runCase('playlists-system-ids');
  const byName = Object.fromEntries(r.summary.items.map((i) => [i.name, i]));
  for (const n of ['Saved Shorts', 'Sounds', 'Liked videos']) {
    assert.equal(byName[n].status, 'skipped', n);
    assert.match(byName[n].reason, /built-in/i, n);
  }
  assert.deepEqual(r.summary.fallback.map((f) => f.id), ['PLreal']);
});

test('empties Watch later: classic "Action menu" rows, "Remove from Watch later", recycled rows, rows loaded by scrolling', async () => {
  const r = await runCase('clear-watch-later');
  // Order varies because recycled rows are processed as they come; every row must be gone.
  assert.deepEqual(((r.events.removedFromList || {}).WL || []).sort(), ['WL Five', 'WL Four', 'WL One', 'WL Three', 'WL Two']);
  assert.equal(r.events.misclicks, undefined, 'wrong menu item clicked: ' + JSON.stringify(r.events.misclicks));
  assert.equal(r.summary.task, 'clear-list');
  assert.equal(r.summary.succeeded, 5);
  assert.equal(r.summary.failed, 0);
  assert.deepEqual(r.dom.likedRows, []);
});

test('empties Saved Shorts (short links, "Remove from Saved Shorts")', async () => {
  const r = await runCase('clear-saved-shorts');
  assert.deepEqual((r.events.removedFromList || {}).YS, ['Short One', 'Short Two']);
  assert.equal(r.summary.succeeded, 2);
  assert.deepEqual(r.dom.likedRows, []);
});

test('empties Sounds ("Remove from Sounds")', async () => {
  const r = await runCase('clear-sounds');
  assert.deepEqual((r.events.removedFromList || {}).SS, ['Sound One']);
  assert.equal(r.summary.succeeded, 1);
});

test('dry run on Watch later reports the remove label and removes nothing', async () => {
  const r = await runCase('clear-watch-later-dry-run');
  assert.equal(r.events.removedFromList, undefined);
  assert.equal(names(r.summary.items, 'dry-run').length, 2);
  assert.ok(r.summary.items[0].menuLabels.includes('Remove from Watch later'));
  assert.deepEqual(r.dom.likedRows, ['WL One', 'WL Two']);
});

test('never removes the wrong video when YouTube re-binds rows while a menu is opening', async () => {
  const r = await runCase('clear-watch-later-laggy');
  assert.deepEqual(((r.events.removedFromList || {}).WL || []).sort(), ['WL Four', 'WL One', 'WL Three', 'WL Two']);
  assert.equal(r.events.duplicateRemovals, undefined, 'a video was "removed" twice: ' + JSON.stringify(r.events.duplicateRemovals));
  assert.equal(r.summary.succeeded, 4, JSON.stringify(r.summary.items.map((i) => [i.name, i.status, i.reason])));
  // every reported name must be a video that was really removed
  const reported = r.summary.items.filter((i) => i.status === 'done').map((i) => i.name).sort();
  assert.deepEqual(reported, ['WL Four', 'WL One', 'WL Three', 'WL Two']);
  assert.deepEqual(r.dom.likedRows, []);
});
