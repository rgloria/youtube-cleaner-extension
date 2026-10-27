/* Drives one test case (chosen by ?case=NAME) and publishes the outcome in <pre id="ytc-result">. */
(async function () {
  const params = new URLSearchParams(location.search);
  const name = params.get('case');
  const M = window.MockYouTube;
  const log = [];
  const result = { case: name, log };

  const channelsPage = () => M.buildChannelsPage({
    channels: [
      { name: 'Alpha Channel' },
      { name: 'Beta Builds' },
      { name: 'Gamma Games', subscribed: false },
      { name: 'Delta Docs' },
    ],
    moreOnScroll: [[{ name: 'Epsilon Eats' }, { name: 'Zeta Zone' }]],
  });

  const playlistsPage = () => M.buildPlaylistsPage({
    playlists: [
      { title: 'My Mix', kind: 'own', id: 'PLown1' },
      { title: 'Cool Saved List', kind: 'saved', id: 'PLsaved1' },
      { title: 'Watch later', kind: 'system', id: 'WL' },
      { title: 'Some Video', kind: 'video', id: 'abc123' },
      { title: 'Old Style Own', kind: 'own', id: 'PLown2', markup: 'grid' },
    ],
    moreOnScroll: [[{ title: 'Late Saved', kind: 'saved', id: 'PLsaved2' }]],
  });

  const cases = {
    'unsubscribe-basic': { page: channelsPage, task: 'unsubscribe', options: {} },
    'unsubscribe-dry-run': { page: channelsPage, task: 'unsubscribe', options: { dryRun: true } },
    'unsubscribe-broken-menu': {
      page: () => M.buildChannelsPage({ channels: [{ name: 'Fine One' }, { name: 'Broken One', brokenMenu: true }, { name: 'Fine Two' }] }),
      task: 'unsubscribe', options: { waitMs: 800 },
    },
    'unsubscribe-no-dialog': {
      page: () => M.buildChannelsPage({ channels: [{ name: 'Direct One', noDialog: true }, { name: 'Dialog One' }] }),
      task: 'unsubscribe', options: {},
    },
    'unsubscribe-direct-dialog': {
      page: () => M.buildChannelsPage({ channels: [{ name: 'Direct Dialog', directDialog: true }, { name: 'Menu One' }] }),
      task: 'unsubscribe', options: {},
    },
    'unsubscribe-dry-run-direct': {
      page: () => M.buildChannelsPage({ channels: [{ name: 'Direct Dialog', directDialog: true }] }),
      task: 'unsubscribe', options: { dryRun: true },
    },
    'unsubscribe-stop': {
      page: channelsPage, task: 'unsubscribe', options: {},
      reporter: { shouldStop: () => M.events.unsubscribed.length >= 1 },
    },
    'playlists-saved-only': { page: playlistsPage, task: 'playlists', options: { removeSavedPlaylists: true, deleteOwnPlaylists: false } },
    'playlists-own-and-saved': { page: playlistsPage, task: 'playlists', options: { removeSavedPlaylists: true, deleteOwnPlaylists: true } },
    'playlists-fallback-list': {
      page: () => M.buildPlaylistsPage({ playlists: [
        { title: 'Mystery List', kind: 'unknown', id: 'PLmystery' },
        { title: 'Cool Saved List', kind: 'saved', id: 'PLsaved1' },
        { title: 'Saved Without Menu', kind: 'saved-nomenu', id: 'PLnomenu' },
        { title: 'Watch later', kind: 'system', id: 'WL' },
      ] }),
      task: 'playlists', options: { removeSavedPlaylists: true, deleteOwnPlaylists: true },
    },
    'playlist-page-own-delete': { page: () => M.buildPlaylistPage({ title: 'Road Trip', kind: 'own' }), task: 'playlist-page', options: { deleteOwnPlaylists: true } },
    'playlist-page-own-disabled': { page: () => M.buildPlaylistPage({ title: 'Road Trip', kind: 'own' }), task: 'playlist-page', options: { deleteOwnPlaylists: false } },
    'playlist-page-own-dry-run': { page: () => M.buildPlaylistPage({ title: 'Road Trip', kind: 'own' }), task: 'playlist-page', options: { deleteOwnPlaylists: true, dryRun: true } },
    'playlist-page-saved-toggle': { page: () => M.buildPlaylistPage({ title: 'Study Beats', kind: 'saved', savedControl: 'toggle' }), task: 'playlist-page', options: { removeSavedPlaylists: true } },
    'playlist-page-saved-menu': { page: () => M.buildPlaylistPage({ title: 'Study Beats', kind: 'saved', savedControl: 'menu' }), task: 'playlist-page', options: { removeSavedPlaylists: true } },
    'playlist-page-course': { page: () => M.buildPlaylistPage({ title: 'AWS Course', kind: 'saved', savedControl: 'toggle', header: 'old', removeLabel: 'Remove from Your courses' }), task: 'playlist-page', options: { removeSavedPlaylists: true } },
    'playlists-system-ids': {
      page: () => M.buildPlaylistsPage({ playlists: [
        { title: 'Saved Shorts', kind: 'saved-nomenu', id: 'YS' },
        { title: 'Sounds', kind: 'saved-nomenu', id: 'SS' },
        { title: 'Liked videos', kind: 'saved-nomenu', id: 'LL' },
        { title: 'Real Saved', kind: 'saved-nomenu', id: 'PLreal' },
      ] }),
      task: 'playlists', options: { removeSavedPlaylists: true, deleteOwnPlaylists: true },
    },
    'playlist-page-saved-disabled': { page: () => M.buildPlaylistPage({ title: 'Study Beats', kind: 'saved', savedControl: 'toggle' }), task: 'playlist-page', options: { removeSavedPlaylists: false } },
    'playlists-recycled': {
      page: () => M.buildPlaylistsPage({ recycle: true, playlists: [
        { title: 'Alpha Own', kind: 'own-direct', id: 'PLa' },
        { title: 'Bravo Own', kind: 'own-direct', id: 'PLb' },
        { title: 'Charlie Saved', kind: 'saved', id: 'PLc' },
        { title: 'Delta Own', kind: 'own', id: 'PLd' },
        { title: 'Watch later', kind: 'system', id: 'WL' },
      ] }),
      task: 'playlists', options: { removeSavedPlaylists: true, deleteOwnPlaylists: true },
    },
    'unlike-recycled': {
      page: () => M.buildLikedVideosPage({ recycle: true, videos: [{ title: 'Liked One', id: 'v1' }, { title: 'Liked Two', id: 'v2' }, { title: 'Liked Three', id: 'v3' }], moreOnScroll: [[{ title: 'Liked Four', id: 'v4' }]] }),
      task: 'unlike', options: {},
    },
    'clear-watch-later': {
      page: () => M.buildBuiltinListPage({ id: 'WL', title: 'Watch later', rowType: 'playlist-video', removeLabel: 'Remove from Watch later', recycle: true,
        videos: [{ title: 'WL One', id: 'w1' }, { title: 'WL Two', id: 'w2' }, { title: 'WL Three', id: 'w3' }], moreOnScroll: [[{ title: 'WL Four', id: 'w4' }, { title: 'WL Five', id: 'w5' }]] }),
      task: 'clear-list', options: {},
    },
    'clear-watch-later-laggy': {
      page: () => M.buildBuiltinListPage({ id: 'WL', title: 'Watch later', rowType: 'playlist-video', removeLabel: 'Remove from Watch later', recycle: true, rebindOnNextMenuOpen: true,
        videos: [{ title: 'WL One', id: 'w1' }, { title: 'WL Two', id: 'w2' }, { title: 'WL Three', id: 'w3' }, { title: 'WL Four', id: 'w4' }] }),
      task: 'clear-list', options: {},
    },
    'clear-saved-shorts': {
      page: () => M.buildBuiltinListPage({ id: 'YS', title: 'Saved Shorts', rowType: 'rich-item', removeLabel: 'Remove from Saved Shorts', recycle: true,
        videos: [{ title: 'Short One', id: 's1' }, { title: 'Short Two', id: 's2' }] }),
      task: 'clear-list', options: {},
    },
    'clear-sounds': {
      page: () => M.buildBuiltinListPage({ id: 'SS', title: 'Sounds', rowType: 'rich-item', removeLabel: 'Remove from Sounds', videos: [{ title: 'Sound One', id: 'o1' }] }),
      task: 'clear-list', options: {},
    },
    'clear-watch-later-dry-run': {
      page: () => M.buildBuiltinListPage({ id: 'WL', title: 'Watch later', rowType: 'playlist-video', removeLabel: 'Remove from Watch later', videos: [{ title: 'WL One', id: 'w1' }, { title: 'WL Two', id: 'w2' }] }),
      task: 'clear-list', options: { dryRun: true },
    },
    'unlike-basic': {
      page: () => M.buildLikedVideosPage({ videos: [{ title: 'Liked One', id: 'v1' }, { title: 'Liked Two', id: 'v2' }, { title: 'Liked Three', id: 'v3' }], moreOnScroll: [[{ title: 'Liked Four', id: 'v4' }, { title: 'Liked Five', id: 'v5' }]] }),
      task: 'unlike', options: {},
    },
    'unlike-static-rows': {
      page: () => M.buildLikedVideosPage({ staticRows: true, silentApi: true, videos: [{ title: 'Liked One', id: 'v1' }, { title: 'Liked Two', id: 'v2' }, { title: 'Liked Three', id: 'v3' }, { title: 'Liked Four', id: 'v4' }, { title: 'Liked Five', id: 'v5' }, { title: 'Liked Six', id: 'v6' }] }),
      task: 'unlike', options: { waitMs: 6000 },
    },
    'unlike-slow-api': {
      page: () => M.buildLikedVideosPage({ staticRows: true, apiDelayMs: 3000, videos: [{ title: 'Liked One', id: 'v1' }, { title: 'Liked Two', id: 'v2' }, { title: 'Liked Three', id: 'v3' }] }),
      task: 'unlike', options: { waitMs: 6000 },
    },
    'clear-list-stalled-rows': {
      page: () => M.buildBuiltinListPage({ id: 'WL', title: 'Watch later', rowType: 'playlist-video', removeLabel: 'Remove from Watch later', recycle: true, visibleLimit: 3,
        videos: [{ title: 'WL One', id: 'w1' }, { title: 'WL Two', id: 'w2' }, { title: 'WL Three', id: 'w3' }, { title: 'WL Four', id: 'w4' }, { title: 'WL Five', id: 'w5' }] }),
      task: 'clear-list', options: {},
    },
    'clear-watch-later-unavailable': {
      page: () => M.buildBuiltinListPage({ id: 'WL', title: 'Watch later', rowType: 'playlist-video', removeLabel: 'Remove from Watch later', recycle: true,
        videos: [{ title: 'WL One', id: 'w1' }, { title: 'WL Two', id: 'w2' }], unavailableHidden: [{ title: '[Deleted video]', id: 'd1' }, { title: '[Private video]', id: 'p1' }] }),
      task: 'clear-list', options: {},
    },
    'unlike-static-rows-confirmed': {
      page: () => M.buildLikedVideosPage({ staticRows: true, videos: [{ title: 'Liked One', id: 'v1' }, { title: 'Liked Two', id: 'v2' }, { title: 'Liked Three', id: 'v3' }] }),
      task: 'unlike', options: { waitMs: 6000 },
    },
    'clear-watch-later-rate-limited': {
      page: () => M.buildBuiltinListPage({ id: 'WL', title: 'Watch later', rowType: 'playlist-video', removeLabel: 'Remove from Watch later', recycle: true, editWindowMs: 2000,
        videos: [{ title: 'WL One', id: 'w1' }, { title: 'WL Two', id: 'w2' }, { title: 'WL Three', id: 'w3' }, { title: 'WL Four', id: 'w4' }, { title: 'WL Five', id: 'w5' }, { title: 'WL Six', id: 'w6' }] }),
      task: 'clear-list', options: { delayMs: 100, waitMs: 6000 },
    },
    'unlike-dry-run': {
      page: () => M.buildLikedVideosPage({ videos: [{ title: 'Liked One', id: 'v1' }, { title: 'Liked Two', id: 'v2' }] }),
      task: 'unlike', options: { dryRun: true },
    },
    'unlike-stop': {
      page: () => M.buildLikedVideosPage({ videos: [{ title: 'Liked One', id: 'v1' }, { title: 'Liked Two', id: 'v2' }, { title: 'Liked Three', id: 'v3' }] }),
      task: 'unlike', options: {},
      reporter: { shouldStop: () => M.events.unliked.length >= 1 },
    },
    'playlists-only': { page: playlistsPage, task: 'playlists', options: { removeSavedPlaylists: true, deleteOwnPlaylists: true, only: ['PLsaved1'] } },
    'unsubscribe-only': { page: channelsPage, task: 'unsubscribe', options: { only: ['beta builds'] } },
    'playlists-dry-run': { page: playlistsPage, task: 'playlists', options: { removeSavedPlaylists: true, deleteOwnPlaylists: true, dryRun: true } },
  };

  try {
    const c = cases[name];
    if (!c) throw new Error('unknown case: ' + name);
    c.page();
    const reporter = Object.assign({ log: (msg) => log.push(String(msg)) }, c.reporter || {});
    if (!window.YTCleaner) throw new Error('window.YTCleaner is not defined (content.js missing or broken)');
    const t0 = Date.now();
    result.summary = await window.YTCleaner.run(c.task, Object.assign({ delayMs: 10 }, c.options), reporter);
    result.elapsedMs = Date.now() - t0;
  } catch (e) {
    result.error = String(e && e.stack || e);
  }
  result.events = M.events;
  result.dom = M.snapshot();

  const pre = document.createElement('pre');
  pre.id = 'ytc-result';
  pre.textContent = btoa(unescape(encodeURIComponent(JSON.stringify(result))));
  document.body.appendChild(pre);
})();
