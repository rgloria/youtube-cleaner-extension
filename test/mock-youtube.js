/*
 * Mock of the YouTube DOM used by the tests. It mimics the markup and the
 * asynchronous menu / dialog behaviour of the real site closely enough to
 * exercise content.js. It is test-only code and never ships in the extension.
 */
(function () {
  const events = { unsubscribed: [], removed: [], deleted: [], unliked: [], menuOpens: 0 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- shared popup container (YouTube reuses a single dropdown + dialog) ----
  function ensurePopupContainer() {
    let c = document.querySelector('ytd-popup-container');
    if (c) return c;
    c = document.createElement('ytd-popup-container');
    c.innerHTML =
      '<tp-yt-iron-dropdown aria-hidden="true" style="display:none; position:fixed; top:100px; left:100px;">' +
      '<div id="contentWrapper"></div></tp-yt-iron-dropdown>' +
      '<tp-yt-paper-dialog aria-hidden="true" style="display:none; position:fixed; top:200px; left:200px;">' +
      '</tp-yt-paper-dialog>';
    document.body.appendChild(c);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDropdown();
    });
    return c;
  }
  function dropdown() { return ensurePopupContainer().querySelector('tp-yt-iron-dropdown'); }
  function dialog() { return ensurePopupContainer().querySelector('tp-yt-paper-dialog'); }
  function isDropdownOpen() { return dropdown().getAttribute('aria-hidden') !== 'true'; }
  function closeDropdown() {
    const d = dropdown();
    d.setAttribute('aria-hidden', 'true');
    d.style.display = 'none';
    d.querySelector('#contentWrapper').innerHTML = '';
    d.__owner = null;
  }
  async function openDropdown(owner, html) {
    events.menuOpens++;
    await sleep(60);
    const d = dropdown();
    d.__owner = owner;
    d.querySelector('#contentWrapper').innerHTML = html;
    d.style.display = 'block';
    d.removeAttribute('aria-hidden');
  }
  function closeDialog() {
    const d = dialog();
    d.setAttribute('aria-hidden', 'true');
    d.style.display = 'none';
    d.innerHTML = '';
  }
  async function openConfirmDialog({ title, confirmLabel, onConfirm }) {
    await sleep(60);
    const d = dialog();
    d.innerHTML =
      '<yt-confirm-dialog-renderer><div id="main"><yt-formatted-string id="title">' + title + '</yt-formatted-string>' +
      '<div id="buttons">' +
      '<yt-button-renderer id="cancel-button"><yt-button-shape><button class="yt-spec-button-shape-next"><div class="yt-spec-button-shape-next__button-text-content">Cancel</div></button></yt-button-shape></yt-button-renderer>' +
      '<yt-button-renderer id="confirm-button"><yt-button-shape><button class="yt-spec-button-shape-next"><div class="yt-spec-button-shape-next__button-text-content">' + confirmLabel + '</div></button></yt-button-shape></yt-button-renderer>' +
      '</div></div></yt-confirm-dialog-renderer>';
    d.style.display = 'block';
    d.removeAttribute('aria-hidden');
    d.querySelector('#cancel-button button').addEventListener('click', () => closeDialog());
    d.querySelector('#confirm-button button').addEventListener('click', async () => {
      await sleep(60);
      closeDialog();
      onConfirm();
    });
  }

  // ---- classic menu items (ytd-menu-service-item-renderer) ----
  function classicMenuHtml(items) {
    return '<ytd-menu-popup-renderer><tp-yt-paper-listbox id="items">' +
      items.map((label) =>
        '<ytd-menu-service-item-renderer role="option" tabindex="0"><tp-yt-paper-item>' +
        '<yt-icon></yt-icon><yt-formatted-string>' + label + '</yt-formatted-string></tp-yt-paper-item></ytd-menu-service-item-renderer>'
      ).join('') + '</tp-yt-paper-listbox></ytd-menu-popup-renderer>';
  }
  // ---- newer menu items (yt-list-item-view-model) ----
  function modernMenuHtml(items) {
    return '<yt-sheet-view-model><div class="ytSheetViewModelHost"><yt-list-view-model role="menu">' +
      items.map((label) =>
        '<yt-list-item-view-model role="menuitem" tabindex="0" class="ytListItemViewModelHost">' +
        '<div class="yt-list-item-view-model-wiz__leading"><yt-icon></yt-icon></div>' +
        '<div class="yt-list-item-view-model-wiz__container"><span class="yt-list-item-view-model-wiz__title">' + label + '</span></div>' +
        '</yt-list-item-view-model>'
      ).join('') + '</yt-list-view-model></div></yt-sheet-view-model>';
  }
  function wireMenuClicks(container, handlers) {
    container.querySelectorAll('ytd-menu-service-item-renderer, yt-list-item-view-model').forEach((item) => {
      const label = item.textContent.replace(/\s+/g, ' ').trim();
      item.addEventListener('click', () => {
        closeDropdown();
        if (handlers[label]) handlers[label]();
      });
    });
  }

  // ---- infinite scroll simulation (polls scroll position; headless fires no scroll events) ----
  function setupContinuation(listEl, batches, renderBatch, showSpinner = true) {
    if (!batches.length) return;
    // The newest lists (e.g. Liked videos) load more rows without any spinner element.
    const cont = document.createElement(showSpinner ? 'ytd-continuation-item-renderer' : 'div');
    if (showSpinner) cont.innerHTML = '<div id="ghost-cards"><tp-yt-paper-spinner active></tp-yt-paper-spinner></div>';
    cont.style.display = 'block';
    cont.style.height = showSpinner ? '40px' : '0px';
    listEl.appendChild(cont);
    let loading = false;
    const timer = setInterval(async () => {
      if (loading || !batches.length) return;
      const nearBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 80;
      if (!nearBottom) return;
      loading = true;
      await sleep(250);
      const batch = batches.shift();
      batch.forEach((spec) => listEl.insertBefore(renderBatch(spec), cont));
      if (!batches.length) { cont.remove(); clearInterval(timer); }
      loading = false;
    }, 100);
  }

  // =====================================================================
  // /feed/channels
  // =====================================================================
  function renderChannel(spec) {
    // Mirrors the markup observed on youtube.com/feed/channels (Oct 2026): a split
    // "Subscribed" button whose main part says "Unsubscribe from X." and a bell
    // toggle that also reads "Subscribed" but only changes notifications.
    const el = document.createElement('ytd-channel-renderer');
    el.className = 'style-scope ytd-expanded-shelf-contents-renderer';
    el.style.cssText = 'display:block; min-height:220px; border-bottom:1px solid #ccc;';
    const subscribed = spec.subscribed !== false;
    el.innerHTML =
      '<div id="content-section">' +
      '<a id="main-link" href="/@' + encodeURIComponent(spec.name) + '"><yt-img-shadow></yt-img-shadow></a>' +
      '<div id="info-section"><div id="info">' +
      '<ytd-channel-name id="channel-name"><div id="container"><div id="text-container">' +
      '<yt-formatted-string id="text">' + spec.name + '</yt-formatted-string></div></div></ytd-channel-name>' +
      '<div id="metadata"><span id="subscribers">1.2M subscribers</span></div>' +
      '</div>' +
      '<div id="buttons"><div id="subscribe-button"><ytd-subscribe-button-renderer' + (subscribed ? ' subscribed' : '') + '><yt-smartimation><div>' +
      '<yt-button-shape><button class="yt-spec-button-shape-next" aria-label="' + (subscribed ? 'Unsubscribe from ' + spec.name + '.' : 'Subscribe to ' + spec.name) + '">' +
      '<div class="yt-spec-button-shape-next__button-text-content"><span>' + (subscribed ? 'Subscribed' : 'Subscribe') + '</span></div></button></yt-button-shape>' +
      (subscribed ? '<yt-animated-action><div><div id="notification-preference-button"><ytd-subscription-notification-toggle-button-renderer-next><yt-button-shape>' +
        '<button class="yt-spec-button-shape-next" aria-label="Current setting is personalized notifications. Tap to change your notification setting for ' + spec.name + '">' +
        '<div class="yt-spec-button-shape-next__button-text-content"><span>Subscribed</span></div></button></yt-button-shape></ytd-subscription-notification-toggle-button-renderer-next></div></div></yt-animated-action>' : '') +
      '</div></yt-smartimation></ytd-subscribe-button-renderer></div></div></div></div>';

    const btnRenderer = el.querySelector('ytd-subscribe-button-renderer');
    const btn = el.querySelector('yt-button-shape > button');
    const bell = el.querySelector('#notification-preference-button button');
    if (bell) {
      bell.addEventListener('click', async () => {
        events.bellClicks = (events.bellClicks || []).concat(spec.name);
        if (isDropdownOpen() && dropdown().__owner === bell) { closeDropdown(); return; }
        await openDropdown(bell, classicMenuHtml(['All', 'Personalized', 'None']));
        wireMenuClicks(dropdown(), {});
      });
    }
    const finish = () => {
      btnRenderer.removeAttribute('subscribed');
      btn.setAttribute('aria-label', 'Subscribe to ' + spec.name);
      btn.querySelector('span').textContent = 'Subscribe';
      const anim = el.querySelector('yt-animated-action');
      if (anim) anim.remove();
      events.unsubscribed.push(spec.name);
    };
    btn.addEventListener('click', async () => {
      if (!btnRenderer.hasAttribute('subscribed')) {
        // clicking "Subscribe" would re-subscribe; the mock records it as a bug.
        events.resubscribed = (events.resubscribed || []).concat(spec.name);
        return;
      }
      if (isDropdownOpen() && dropdown().__owner === btn) { closeDropdown(); return; }
      if (spec.brokenMenu) return; // nothing ever appears
      if (spec.directDialog) {
        await openConfirmDialog({ title: 'Unsubscribe from ' + spec.name + '?', confirmLabel: 'Unsubscribe', onConfirm: finish });
        return;
      }
      await openDropdown(btn, classicMenuHtml(['All', 'Personalized', 'None', 'Unsubscribe']));
      wireMenuClicks(dropdown(), {
        Unsubscribe: async () => {
          if (spec.noDialog) { await sleep(60); finish(); return; }
          await openConfirmDialog({ title: 'Unsubscribe from ' + spec.name + '?', confirmLabel: 'Unsubscribe', onConfirm: finish });
        },
      });
    });
    return el;
  }

  function buildChannelsPage({ channels, moreOnScroll = [] }) {
    document.body.innerHTML = '';
    const app = document.createElement('ytd-app');
    app.innerHTML =
      '<ytd-page-manager><ytd-browse page-subtype="channels"><ytd-two-column-browse-results-renderer>' +
      '<ytd-section-list-renderer><div id="contents"><ytd-item-section-renderer><div id="contents">' +
      '<ytd-shelf-renderer><div id="contents"><ytd-expanded-shelf-contents-renderer><div id="grid-container"></div>' +
      '</ytd-expanded-shelf-contents-renderer></div></ytd-shelf-renderer>' +
      '</div></ytd-item-section-renderer></div></ytd-section-list-renderer>' +
      '</ytd-two-column-browse-results-renderer></ytd-browse></ytd-page-manager>';
    document.body.appendChild(app);
    ensurePopupContainer();
    // YouTube's sidebar uses the same tp-yt-paper-item elements as menus. An
    // entry is deliberately named "Unsubscribe" to prove the cleaner never
    // mistakes sidebar entries for menu items.
    const guide = document.createElement('ytd-guide-renderer');
    guide.style.cssText = 'position:fixed; left:0; top:0; width:200px;';
    guide.innerHTML = '<div id="guide-content"><ytd-guide-section-renderer>' +
      ['Home', 'Subscriptions', 'Unsubscribe', 'Delete playlist', 'Remove from library'].map((label) =>
        '<ytd-guide-entry-renderer><tp-yt-paper-item role="link"><yt-formatted-string>' + label + '</yt-formatted-string></tp-yt-paper-item></ytd-guide-entry-renderer>').join('') +
      '</ytd-guide-section-renderer></div>';
    guide.querySelectorAll('tp-yt-paper-item').forEach((item) => item.addEventListener('click', () => {
      events.guideClicks = (events.guideClicks || []).concat(item.textContent.trim());
    }));
    document.body.insertBefore(guide, app);
    const list = app.querySelector('#grid-container');
    channels.forEach((c) => list.appendChild(renderChannel(c)));
    setupContinuation(list, moreOnScroll.map((b) => b.slice()), renderChannel);
  }

  // =====================================================================
  // /feed/playlists
  // =====================================================================
  // With recycle=true the grid behaves like the real site: deleting playlist i
  // re-binds every following tile to the next playlist and drops the LAST tile,
  // so the deleted tile's element stays connected and simply shows another playlist.
  function playlistMenuFor(spec, onRemove) {
    const labels = ['Add to queue'];
    if (spec.kind === 'own') labels.push('Delete playlist');
    if (spec.kind === 'own-direct') labels.push('Delete');          // newest UI: no confirmation
    if (spec.kind === 'saved') labels.push('Remove from library');
    // kind 'unknown': only "Add to queue" (what some layouts show for playlists)
    const handlers = {
      'Delete playlist': () => openConfirmDialog({
        title: 'Delete playlist?',
        confirmLabel: 'Delete',
        onConfirm: () => { events.deleted.push(spec.title); onRemove(); },
      }),
      'Delete': async () => { await sleep(300); events.deleted.push(spec.title); onRemove(); },
      'Remove from library': async () => { await sleep(60); events.removed.push(spec.title); onRemove(); },
    };
    return { labels, handlers };
  }

  function lockupPlaylistHtml(spec) {
    const href = spec.kind === 'video' ? '/watch?v=' + spec.id : '/watch?v=first&list=' + spec.id + '&pp=sAgC';
    return '<div id="content"><yt-lockup-view-model class="ytLockupViewModelHost"><div class="yt-lockup-view-model-wiz">' +
      '<a class="yt-lockup-view-model-wiz__content-image" href="' + href + '"><yt-thumbnail-view-model></yt-thumbnail-view-model></a>' +
      '<div class="yt-lockup-view-model-wiz__metadata"><yt-lockup-metadata-view-model class="ytLockupMetadataViewModelHost">' +
      '<div class="yt-lockup-metadata-view-model-wiz__text-container">' +
      '<h3 class="yt-lockup-metadata-view-model-wiz__heading-reset"><a class="yt-lockup-metadata-view-model-wiz__title" href="' + href + '" title="' + spec.title + '"><span>' + spec.title + '</span></a></h3>' +
      '<div class="yt-content-metadata-view-model-wiz"><span>' + (spec.kind === 'saved' ? 'Someone Else' : 'Playlist') + ' • 12 videos</span></div>' +
      '</div>' +
      (spec.kind === 'saved-nomenu' ? '' :
      '<div class="yt-lockup-metadata-view-model-wiz__menu-button"><button-view-model class="ytLockupMetadataViewModelMenuButton">' +
      '<button class="yt-spec-button-shape-next yt-spec-button-shape-next--text" aria-label="More actions"><yt-icon></yt-icon></button>' +
      '</button-view-model></div>') +
      '</yt-lockup-metadata-view-model></div></div></yt-lockup-view-model></div>';
  }

  function gridPlaylistHtml(spec) {
    // Older markup still seen on some accounts.
    return '<div id="thumbnail"><a id="thumbnail-link" href="/playlist?list=' + spec.id + '"></a></div>' +
      '<div id="details"><div id="meta"><h3><a id="video-title" href="/playlist?list=' + spec.id + '" title="' + spec.title + '">' + spec.title + '</a></h3></div>' +
      '<div id="menu"><ytd-menu-renderer><div id="top-level-buttons-computed"></div>' +
      '<yt-icon-button id="button" class="dropdown-trigger"><button id="button" aria-label="Action menu"><yt-icon></yt-icon></button></yt-icon-button>' +
      '</ytd-menu-renderer></div></div>';
  }

  function buildPlaylistsPage({ playlists, moreOnScroll = [], recycle = false }) {
    document.body.innerHTML = '';
    const app = document.createElement('ytd-app');
    app.innerHTML =
      '<ytd-page-manager><ytd-browse page-subtype="playlists"><ytd-two-column-browse-results-renderer>' +
      '<ytd-rich-grid-renderer><div id="contents"></div></ytd-rich-grid-renderer>' +
      '</ytd-two-column-browse-results-renderer></ytd-browse></ytd-page-manager>';
    document.body.appendChild(app);
    ensurePopupContainer();
    const list = app.querySelector('ytd-rich-grid-renderer #contents');
    const specs = [];
    const elements = [];

    function fill(el, spec) {
      el.__spec = spec;
      el.style.cssText = 'display:inline-block; width:300px; min-height:260px; vertical-align:top;';
      el.innerHTML = spec.markup === 'grid' ? gridPlaylistHtml(spec) : lockupPlaylistHtml(spec);
      const btn = el.querySelector(spec.markup === 'grid' ? 'button#button' : 'button');
      if (!btn) return;
      btn.addEventListener('click', async () => {
        const current = el.__spec;
        if (isDropdownOpen() && dropdown().__owner === btn) { closeDropdown(); return; }
        const { labels, handlers } = playlistMenuFor(current, () => removeSpec(current));
        await openDropdown(btn, spec.markup === 'grid' ? classicMenuHtml(labels) : modernMenuHtml(labels));
        wireMenuClicks(dropdown(), handlers);
      });
    }

    function removeSpec(spec) {
      const i = specs.indexOf(spec);
      if (i < 0) return;
      specs.splice(i, 1);
      if (!recycle) { const el = elements.splice(i, 1)[0]; el.remove(); return; }
      for (let j = i; j < specs.length; j++) fill(elements[j], specs[j]);
      const last = elements.pop();
      if (last) last.remove();
    }

    function add(spec, before) {
      const el = document.createElement(spec.markup === 'grid' ? 'ytd-grid-playlist-renderer' : 'ytd-rich-item-renderer');
      fill(el, spec);
      specs.push(spec);
      elements.push(el);
      if (before) list.insertBefore(el, before); else list.appendChild(el);
      return el;
    }

    playlists.forEach((p) => add(p));
    // continuation: appended items join the live model too
    const batches = moreOnScroll.map((b) => b.slice());
    if (batches.length) {
      const cont = document.createElement('ytd-continuation-item-renderer');
      cont.style.cssText = 'display:block; height:40px;';
      list.appendChild(cont);
      let loading = false;
      const timer = setInterval(async () => {
        if (loading || !batches.length) return;
        const nearBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 80;
        if (!nearBottom) return;
        loading = true;
        await sleep(250);
        batches.shift().forEach((spec) => add(spec, cont));
        if (!batches.length) { cont.remove(); clearInterval(timer); }
        loading = false;
      }, 100);
    }
  }

  // =====================================================================
  // /playlist?list=... (single playlist page)
  // =====================================================================
  function buildPlaylistPage({ title, kind, savedControl = 'toggle', header = 'new', removeLabel = 'Remove from library' }) {
    document.body.innerHTML = '';
    const app = document.createElement('ytd-app');
    // The real page has several empty <div id="header"> elements (masthead, guide) BEFORE the playlist header.
    const decoys = '<ytd-masthead><div id="header"></div></ytd-masthead><div id="guide"><div id="header"></div></div>';
    const oldHeader =
      '<ytd-playlist-header-renderer><div class="immersive-header-content">' +
      '<yt-dynamic-sizing-formatted-string id="title"><yt-formatted-string>' + title + '</yt-formatted-string></yt-dynamic-sizing-formatted-string>' +
      '<div id="owner-text">' + (kind === 'own' ? 'Me' : 'Someone Else') + ' · Course</div>' +
      '<div class="metadata-buttons-wrapper">' +
      (kind === 'saved' && savedControl === 'toggle' ? '<toggle-button-view-model><button-view-model><button class="yt-spec-button-shape-next" aria-label="' + removeLabel + '" aria-pressed="true"><yt-icon></yt-icon></button></button-view-model></toggle-button-view-model>' : '') +
      '<button-view-model><button class="yt-spec-button-shape-next" aria-label="Share"><yt-icon></yt-icon></button></button-view-model>' +
      '<ytd-menu-renderer><yt-icon-button id="button"><button id="more" aria-label="Action menu"><yt-icon></yt-icon></button></yt-icon-button></ytd-menu-renderer>' +
      '</div></div></ytd-playlist-header-renderer>' +
      '<ytd-section-list-renderer><ytd-item-section-renderer><ytd-playlist-video-list-renderer>' +
      '<ytd-playlist-video-renderer><a href="/watch?v=v1&list=' + encodeURIComponent(title) + '"><span id="video-title">First video</span></a></ytd-playlist-video-renderer>' +
      '</ytd-playlist-video-list-renderer></ytd-item-section-renderer></ytd-section-list-renderer>';
    app.innerHTML = header === 'old'
      ? decoys + '<ytd-page-manager><ytd-browse page-subtype="playlist"><ytd-two-column-browse-results-renderer>' + oldHeader + '</ytd-two-column-browse-results-renderer></ytd-browse></ytd-page-manager>'
      : decoys +
      '<ytd-page-manager><ytd-browse page-subtype="playlist"><ytd-two-column-browse-results-renderer>' +
      '<div id="page-header"><yt-page-header-renderer><yt-page-header-view-model>' +
      '<div class="yt-page-header-view-model-wiz__page-header-headline">' +
      '<h1 class="yt-page-header-view-model-wiz__page-header-title"><span class="yt-core-attributed-string">' + title + '</span></h1>' +
      '<yt-content-metadata-view-model><span>' + (kind === 'own' ? 'Me' : 'Someone Else') + ' • Playlist • 10 videos</span></yt-content-metadata-view-model>' +
      '<yt-flexible-actions-view-model><div class="yt-flexible-actions-view-model-wiz">' +
      '<button-view-model><button class="yt-spec-button-shape-next" aria-label="Play all">Play all</button></button-view-model>' +
      '<button-view-model><button class="yt-spec-button-shape-next" aria-label="Shuffle">Shuffle</button></button-view-model>' +
      '<button-view-model><button class="yt-spec-button-shape-next" aria-label="Share"><yt-icon></yt-icon></button></button-view-model>' +
      '<button-view-model id="save-slot"></button-view-model>' +
      '<button-view-model><button id="more" class="yt-spec-button-shape-next" aria-label="More actions"><yt-icon></yt-icon></button></button-view-model>' +
      '</div></yt-flexible-actions-view-model>' +
      '</div></yt-page-header-view-model></yt-page-header-renderer></div>' +
      '<ytd-section-list-renderer><ytd-item-section-renderer><ytd-playlist-video-list-renderer>' +
      '<ytd-playlist-video-renderer><a href="/watch?v=v1&list=' + encodeURIComponent(title) + '"><span id="video-title">First video</span></a>' +
      '<ytd-menu-renderer><yt-icon-button id="button"><button id="button" aria-label="Action menu"></button></yt-icon-button></ytd-menu-renderer></ytd-playlist-video-renderer>' +
      '</ytd-playlist-video-list-renderer></ytd-item-section-renderer></ytd-section-list-renderer>' +
      '</ytd-two-column-browse-results-renderer></ytd-browse></ytd-page-manager>';
    document.body.appendChild(app);
    ensurePopupContainer();

    // A saved (someone else's) playlist shows a bookmark toggle in the header.
    if (kind === 'saved' && savedControl === 'toggle') {
      let b;
      if (header === 'old') {
        b = app.querySelector('ytd-playlist-header-renderer toggle-button-view-model button');
      } else {
        const slot = app.querySelector('#save-slot');
        slot.innerHTML = '<button class="yt-spec-button-shape-next" aria-label="' + removeLabel + '"><yt-icon></yt-icon></button>';
        b = slot.querySelector('button');
      }
      b.addEventListener('click', async () => {
        await sleep(60);
        if (b.getAttribute('aria-label') === removeLabel) { events.removed.push(title); b.setAttribute('aria-label', 'Save playlist'); }
        else { events.resaved = (events.resaved || []).concat(title); b.setAttribute('aria-label', removeLabel); }
      });
    }
    // Video rows have their own menus; the cleaner must not touch them.
    const rowBtn = app.querySelector('ytd-playlist-video-renderer button');
    if (rowBtn) rowBtn.addEventListener('click', async () => {
      await openDropdown(null, classicMenuHtml(['Add to queue', 'Save to Watch later', 'Remove from ' + title]));
      wireMenuClicks(dropdown(), { ['Remove from ' + title]: () => { events.videoRemoved = (events.videoRemoved || []).concat('First video'); } });
    });

    const more = app.querySelector('#more');
    more.addEventListener('click', async () => {
      if (isDropdownOpen() && dropdown().__owner === more) { closeDropdown(); return; }
      const labels = header === 'old' ? ['Report playlist'] : ['Add all to queue'];
      if (kind === 'own') labels.push('Edit', 'Delete playlist');
      if (kind === 'saved' && savedControl === 'menu') labels.push('Remove from library');
      await openDropdown(more, modernMenuHtml(labels));
      wireMenuClicks(dropdown(), {
        'Delete playlist': () => openConfirmDialog({
          title: 'Delete playlist?',
          confirmLabel: 'Delete',
          onConfirm: () => { events.deleted.push(title); app.querySelector('#page-header').innerHTML = '<h1>This playlist does not exist.</h1>'; },
        }),
        'Remove from library': async () => { await sleep(60); events.removed.push(title); },
      });
    });
  }

  // =====================================================================
  // /playlist?list=LL (Liked videos)
  // =====================================================================
  // Row markup variants seen on youtube.com (Oct 2026):
  //   'lockup'         Liked videos:  #contents > yt-lockup-view-model, "More actions"
  //   'playlist-video' Watch later:   #contents > ytd-playlist-video-renderer, "Action menu" (classic menu)
  //   'rich-item'      Saved Shorts / Sounds: #contents > ytd-rich-item-renderer > yt-lockup-view-model, /shorts/ links
  function listRowHtml(spec, rowType, listId) {
    const href = rowType === 'rich-item' ? '/shorts/' + spec.id : '/watch?v=' + spec.id + '&list=' + listId + '&index=1';
    const lockup = (menuAria) =>
      '<div class="yt-lockup-view-model-wiz yt-lockup-view-model-wiz--horizontal">' +
      '<a class="yt-lockup-view-model-wiz__content-image" href="' + href + '"><yt-thumbnail-view-model></yt-thumbnail-view-model></a>' +
      '<div class="yt-lockup-view-model-wiz__metadata"><yt-lockup-metadata-view-model class="ytLockupMetadataViewModelHost">' +
      '<div class="yt-lockup-metadata-view-model-wiz__text-container">' +
      '<h3 class="yt-lockup-metadata-view-model-wiz__heading-reset"><a class="yt-lockup-metadata-view-model-wiz__title" href="' + href + '" title="' + spec.title + '"><span>' + spec.title + '</span></a></h3>' +
      '<div class="yt-content-metadata-view-model-wiz"><span>Some Channel • 1.2M views</span></div></div>' +
      '<div class="yt-lockup-metadata-view-model-wiz__menu-button"><button-view-model class="ytLockupMetadataViewModelMenuButton">' +
      '<button class="yt-spec-button-shape-next yt-spec-button-shape-next--text" aria-label="' + menuAria + '"><yt-icon></yt-icon></button>' +
      '</button-view-model></div>' +
      '</yt-lockup-metadata-view-model></div></div>';
    if (rowType === 'lockup') return lockup('More actions');
    if (rowType === 'rich-item') return '<div id="content"><yt-lockup-view-model class="ytLockupViewModelHost">' + lockup('More actions') + '</yt-lockup-view-model></div>';
    // playlist-video
    return '<div id="content"><ytd-thumbnail><a id="thumbnail" href="' + href + '"></a></ytd-thumbnail>' +
      '<div id="meta"><h3><a id="video-title" href="' + href + '" title="' + spec.title + '">' + spec.title + '</a></h3><div id="byline">Some Channel</div></div>' +
      '<div id="menu"><ytd-menu-renderer><yt-icon-button id="button" class="dropdown-trigger"><button id="button" aria-label="Action menu"><yt-icon></yt-icon></button></yt-icon-button></ytd-menu-renderer></div></div>';
  }

  function buildBuiltinListPage({ id = 'LL', title = 'Liked videos', rowType = 'lockup', removeLabel = 'Remove from Liked videos', videos, moreOnScroll = [], recycle = false, rebindOnNextMenuOpen = false, staticRows = false,
                                  editWindowMs = 0, silentApi = false, persist = false, apiDelayMs = 0, visibleLimit = 0, unavailableHidden = [] }) {
    document.body.innerHTML = '';
    const app = document.createElement('ytd-app');
    app.innerHTML =
      '<ytd-masthead><div id="header"></div></ytd-masthead>' +
      '<ytd-page-manager><ytd-browse page-subtype="playlist"><ytd-two-column-browse-results-renderer>' +
      '<div id="header"><ytd-playlist-header-renderer><yt-dynamic-sizing-formatted-string id="title"><yt-formatted-string>' + title + '</yt-formatted-string></yt-dynamic-sizing-formatted-string>' +
      '<yt-formatted-string id="mock-count"></yt-formatted-string><div>' +
      '<button-view-model><button aria-label="Play all">Play all</button></button-view-model>' +
      '<button-view-model><button aria-label="Shuffle">Shuffle</button></button-view-model>' +
      '<yt-icon-button><button id="header-menu" aria-label="Action menu">&#8942;</button></yt-icon-button></div></ytd-playlist-header-renderer></div>' +
      (unavailableHidden.length ? '<ytd-alert-with-button-renderer>Unavailable videos are hidden</ytd-alert-with-button-renderer>' : '') +
      '<div><div id="contents"></div></div>' +
      '</ytd-two-column-browse-results-renderer></ytd-browse></ytd-page-manager>';
    document.body.appendChild(app);
    ensurePopupContainer();
    const list = app.querySelector('#contents');
    const specs = [];
    const elements = [];
    const rowTag = rowType === 'lockup' ? 'yt-lockup-view-model' : rowType === 'rich-item' ? 'ytd-rich-item-renderer' : 'ytd-playlist-video-renderer';
    const otherItems = rowType === 'playlist-video' ? ['Add to queue', removeLabel, 'Share', 'Move to top', 'Move to bottom'] : ['Add to queue', removeLabel, 'Send feedback'];
    const menuItems = rowType === 'lockup' ? ['Add to queue', 'Save to Watch later', 'Save to playlist', 'Download', 'Share', removeLabel] : otherItems;

    let pendingRebind = null;   // deferred re-binding of the rows after a removed one
    // The "server": every removal is one request to /youtubei/v1/... whose status is the only
    // outcome signal. Like YouTube, a playlist edit within editWindowMs of an accepted one is
    // rejected with 409 - and the page drops the row anyway.
    let lastAcceptedAt = -Infinity;
    const api = (endpoint, status) => silentApi ? Promise.resolve() :
      sleep(apiDelayMs).then(() => fetch('/youtubei/v1/' + endpoint + '?mock_status=' + status, { method: 'POST', body: '{}' })).catch(() => {});
    const storeKey = 'mock-removed-' + id;
    let removedBefore = [];
    if (persist) { try { removedBefore = JSON.parse(localStorage.getItem(storeKey) || '[]'); } catch (e) { removedBefore = []; } }
    function flushRebind() { if (pendingRebind) { const f = pendingRebind; pendingRebind = null; f(); } }

    function fill(el, spec) {
      el.__spec = spec;
      el.className = rowType === 'lockup' ? 'ytLockupViewModelWrapper' : '';
      el.style.cssText = 'display:block; min-height:120px; border-bottom:1px solid #ddd;';
      el.innerHTML = listRowHtml(spec, rowType, id);
      const btn = el.querySelector(rowType === 'playlist-video' ? 'button#button' : 'button');
      btn.addEventListener('click', async () => {
        if (isDropdownOpen() && dropdown().__owner === btn) { closeDropdown(); return; }
        flushRebind();   // YouTube finishes re-rendering the list right as the menu opens
        await openDropdown(btn, rowType === 'playlist-video' ? classicMenuHtml(menuItems) : modernMenuHtml(menuItems));
        const current = () => el.__spec;   // the menu acts on what the row holds when the item is clicked
        const handlers = {
          'Save to Watch later': () => { events.misclicks = (events.misclicks || []).concat('Save to Watch later: ' + current().title); },
          'Save to playlist': () => { events.misclicks = (events.misclicks || []).concat('Save to playlist: ' + current().title); },
          'Move to top': () => { events.misclicks = (events.misclicks || []).concat('Move to top: ' + current().title); },
        };
        handlers[removeLabel] = async () => {
          await sleep(60);
          const cur = current();
          if (specs.indexOf(cur) < 0) { events.duplicateRemovals = (events.duplicateRemovals || []).concat(cur.title); return; }
          const now = Date.now();
          const accepted = !editWindowMs || now - lastAcceptedAt >= editWindowMs;
          await api(id === 'LL' ? 'like/removelike' : 'browse/edit_playlist', accepted ? 200 : 409);
          if (!accepted) {
            events.rejected = (events.rejected || []).concat(cur.title);
            dropRow(cur);   // the row goes, the video stays in the list
            return;
          }
          lastAcceptedAt = now;
          total--; updateCount();
          if (persist) { removedBefore = removedBefore.concat(cur.id); localStorage.setItem(storeKey, JSON.stringify(removedBefore)); }
          events.unliked.push(cur.title);
          (events.removedFromList = events.removedFromList || {})[id] = (events.removedFromList[id] || []).concat(cur.title);
          removeSpec(cur);
        };
        wireMenuClicks(dropdown(), handlers);
      });
    }

    function dropRow(spec) {
      const i = specs.indexOf(spec);
      if (i < 0) return;
      specs.splice(i, 1);
      if (staticRows) return;
      elements.splice(i, 1)[0].remove();
    }

    function removeSpec(spec) {
      const i = specs.indexOf(spec);
      if (i < 0) return;
      specs.splice(i, 1);
      if (staticRows) return;   // the page gives no feedback at all: the row stays exactly as it was
      if (!recycle) { const el = elements.splice(i, 1)[0]; el.remove(); return; }
      // the removed row shows the next item right away...
      if (i < specs.length) fill(elements[i], specs[i]);
      const rest = () => {
        for (let j = i + 1; j < specs.length; j++) fill(elements[j], specs[j]);
        const last = elements.pop();
        if (last) last.remove();
      };
      // ...the rows after it follow immediately, or only when the next menu opens (laggy re-render)
      // (YouTube finishes the re-render on its own after a moment even if no menu opens)
      if (rebindOnNextMenuOpen) { pendingRebind = rest; setTimeout(flushRebind, 1500); } else rest();
    }

    function add(spec, before) {
      const el = document.createElement(rowTag);
      fill(el, spec);
      specs.push(spec);
      elements.push(el);
      if (before) list.insertBefore(el, before); else list.appendChild(el);
    }

    // The header count is the server's truth: everything not yet accepted-removed, shown or not.
    const remainingAll = videos.filter((v) => !removedBefore.includes(v.id));
    let total = remainingAll.length + moreOnScroll.reduce((n, b) => n + b.length, 0) + unavailableHidden.length;
    // The header's Action menu: "Show unavailable videos" adds the hidden (deleted / private) rows.
    app.querySelector('#header-menu').addEventListener('click', async () => {
      const items = (unavailableHidden.length ? ['Show unavailable videos'] : []).concat(['Add videos', 'Add all to...']);
      await openDropdown(app.querySelector('#header-menu'), classicMenuHtml(items));
      wireMenuClicks(dropdown(), { 'Show unavailable videos': () => {
        events.showUnavailableClicks = (events.showUnavailableClicks || 0) + 1;
        const alert = app.querySelector('ytd-alert-with-button-renderer');
        if (alert) alert.remove();
        unavailableHidden.splice(0).forEach((v) => add(v));
      } });
    });
    const updateCount = () => { app.querySelector('#mock-count').textContent = total + ' videos'; };
    updateCount();
    // Like YouTube when its continuation stalls, a visibleLimit page never shows more than that many rows.
    (visibleLimit ? remainingAll.slice(0, visibleLimit) : remainingAll).forEach((v) => add(v));
    const batches = moreOnScroll.map((b) => b.slice());
    if (batches.length) {
      const cont = document.createElement('div');   // the real lists have no spinner element
      cont.style.cssText = 'display:block; height:0px;';
      list.appendChild(cont);
      let loading = false;
      const timer = setInterval(async () => {
        if (loading || !batches.length) return;
        const nearBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 80;
        if (!nearBottom) return;
        loading = true;
        await sleep(250);
        batches.shift().forEach((spec) => add(spec, cont));
        if (!batches.length) { cont.remove(); clearInterval(timer); }
        loading = false;
      }, 100);
    }
  }

  const buildLikedVideosPage = (o) => buildBuiltinListPage(Object.assign({ id: 'LL', title: 'Liked videos', rowType: 'lockup', removeLabel: 'Remove from Liked videos' }, o));

  // ---- state inspection for assertions ----
  function snapshot() {
    return {
      dropdownOpen: !!document.querySelector('tp-yt-iron-dropdown') && isDropdownOpen(),
      dialogOpen: !!document.querySelector('tp-yt-paper-dialog') && dialog().getAttribute('aria-hidden') !== 'true',
      subscribeButtons: Array.from(document.querySelectorAll('ytd-channel-renderer')).map((el) => ({
        name: el.querySelector('#text').textContent.trim(),
        text: el.querySelector('yt-button-shape > button span').textContent.trim(),
        bell: !!el.querySelector('#notification-preference-button'),
      })),
      playlistTitles: Array.from(document.querySelectorAll('ytd-rich-item-renderer, ytd-grid-playlist-renderer'))
        .map((el) => (el.querySelector('[title]') || {}).getAttribute?.('title') || null)
        .filter(Boolean),
      continuationPresent: !!document.querySelector('ytd-continuation-item-renderer'),
      likedRows: Array.from(document.querySelectorAll('#contents > yt-lockup-view-model, #contents > ytd-playlist-video-renderer, #contents > ytd-rich-item-renderer')).map((el) => el.querySelector('[title]').getAttribute('title')),
    };
  }

  window.MockYouTube = { buildChannelsPage, buildPlaylistsPage, buildPlaylistPage, buildLikedVideosPage, buildBuiltinListPage, events, snapshot };
})();
