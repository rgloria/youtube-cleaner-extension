/* Builds the mock page matching the current URL. content.js is injected by the extension itself. */
(function () {
  const M = window.MockYouTube;
  const list = new URLSearchParams(location.search).get('list');
  if (location.pathname === '/feed/channels') {
    M.buildChannelsPage({
      channels: [{ name: 'Alpha Channel' }, { name: 'Beta Builds' }, { name: 'Gamma Games', subscribed: false }, { name: 'Delta Docs' }],
      moreOnScroll: [[{ name: 'Epsilon Eats' }, { name: 'Zeta Zone' }]],
    });
  } else if (location.pathname === '/feed/playlists') {
    M.buildPlaylistsPage({
      recycle: true,
      playlists: [
        { title: 'My Mix', kind: 'own', id: 'PLown1' },
        { title: 'Cool Saved List', kind: 'saved', id: 'PLsaved1' },
        { title: 'Mystery List', kind: 'unknown', id: 'PLmystery' },
        { title: 'Watch later', kind: 'system', id: 'WL' },
      ],
    });
  } else if (location.pathname === '/playlist' && list === 'LL') {
    M.buildLikedVideosPage({ recycle: true, videos: [{ title: 'Liked One', id: 'v1' }, { title: 'Liked Two', id: 'v2' }] });
  } else if (location.pathname === '/playlist' && list === 'WL') {
    M.buildBuiltinListPage({ id: 'WL', title: 'Watch later', rowType: 'playlist-video', removeLabel: 'Remove from Watch later', recycle: true, editWindowMs: 2000, persist: true, videos: [{ title: 'WL One', id: 'w1' }, { title: 'WL Two', id: 'w2' }, { title: 'WL Three', id: 'w3' }] });
  } else if (location.pathname === '/playlist' && list === 'YS') {
    M.buildBuiltinListPage({ id: 'YS', title: 'Saved Shorts', rowType: 'rich-item', removeLabel: 'Remove from Saved Shorts', recycle: true, visibleLimit: 1, persist: true, videos: [1, 2, 3, 4, 5, 6].map((n) => ({ title: 'Short ' + n, id: 's' + n })) });
  } else if (location.pathname === '/playlist' && list === 'SS') {
    M.buildBuiltinListPage({ id: 'SS', title: 'Sounds', rowType: 'rich-item', removeLabel: 'Remove from Sounds', recycle: true, videos: [{ title: 'Sound One', id: 'o1' }, { title: 'Sound Two', id: 'o2' }] });
  } else if (location.pathname === '/playlist') {
    M.buildPlaylistPage({ title: list === 'PLmystery' ? 'Mystery List' : String(list), kind: 'own' });
  } else {
    document.body.textContent = 'unknown mock page: ' + location.pathname;
  }
})();
