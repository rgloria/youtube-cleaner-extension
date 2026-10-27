/*
 * YouTube Cleaner - content script.
 *
 * Runs inside youtube.com and drives the real page UI the way a person would:
 * it opens the "Subscribed" menu and picks "Unsubscribe", or opens a playlist's
 * "More actions" menu and picks "Remove from library" / "Delete playlist".
 *
 * Everything that depends on YouTube's markup or wording lives in CONFIG so it
 * can be adjusted in one place when YouTube changes its UI. A dry run reports
 * the menu labels it saw, which is the quickest way to find out what needs
 * adjusting.
 */
(function () {
  'use strict';
  if (window.YTCleaner && window.YTCleaner.__installed) return;

  const VERSION = '1.0.0';

  const CONFIG = {
    waitMs: 5000,          // how long to wait for a menu / dialog / state change
    delayMs: 700,          // pause between items (be gentle with YouTube)
    loadMoreWaitMs: 3500,  // how long to wait for more items after scrolling down
    scrollIdleRounds: 3,   // consecutive "nothing new" scrolls before we consider the list complete
    initialWaitMs: 15000,  // how long to wait for a freshly loaded page to show its first items
    rowGoneGraceMs: 800,   // after a row's menu has closed, how long to still wait for the row itself to go
    removalResponseWaitMs: 8000,  // how long to wait for YouTube's own removal request to finish (3s+ when YouTube is busy)
    rejectedPauseMs: 2000,        // pause between items once YouTube has rejected a removal for coming too fast
    rejectedPauseStepMs: 500,     // how much longer to pause after each further rejection
    maxPauseMs: 15000,
    // YouTube's own requests that carry out a removal. Their HTTP status, read from the performance
    // timeline, is the only reliable outcome signal: the page drops the row even when the server says
    // no (a playlist edit within about two seconds of the previous one gets a 409).
    removalRequest: /\/youtubei\/v1\/(browse\/edit_playlist|like\/removelike|playlist\/[a-z_]+)(\?|$)/,
    selectors: {
      channelItem: 'ytd-channel-renderer',
      channelName: ['ytd-channel-name #text', '#channel-title', 'yt-formatted-string#text', '#text', 'a#main-link'],
      channelButtons: 'ytd-subscribe-button-renderer button, yt-subscribe-button-view-model button, ' +
        'ytd-subscribe-button-renderer tp-yt-paper-button, #subscribe-button button, tp-yt-paper-button#subscribe-button',
      // The bell next to "Subscribed" only changes notification settings; never click it.
      notificationToggle: '#notification-preference-button, ytd-subscription-notification-toggle-button-renderer-next, ' +
        'ytd-subscription-notification-toggle-button-renderer, [aria-label*="notification" i]',
      popupHost: 'ytd-popup-container, tp-yt-iron-dropdown, yt-sheet-view-model, [role="menu"], [role="listbox"]',
      // Regions that reuse menu-like elements (the sidebar, the header) but are never menus.
      notMenu: 'ytd-guide-renderer, ytd-mini-guide-renderer, tp-yt-app-drawer, ytd-masthead, #guide, #guide-content, ' +
        'ytd-guide-section-renderer, ytd-guide-entry-renderer, ytd-masthead #search',
      menuItem: 'ytd-menu-service-item-renderer, ytd-menu-navigation-item-renderer, yt-list-item-view-model, ' +
        '[role="menuitem"], [role="option"], tp-yt-paper-item',
      dialog: 'yt-confirm-dialog-renderer, tp-yt-paper-dialog, yt-dialog-view-model, dialog[open], [role="dialog"], [role="alertdialog"]',
      dialogButton: 'button, tp-yt-paper-button, yt-button-renderer, [role="button"]',
      playlistItem: 'ytd-rich-item-renderer, ytd-grid-playlist-renderer, ytd-playlist-renderer, ytd-compact-playlist-renderer, yt-lockup-view-model',
      playlistLink: 'a[href*="list="]',
      playlistTitle: ['#video-title', '.yt-lockup-metadata-view-model-wiz__title', '.yt-lockup-metadata-view-model__title',
        'h3 a[title]', 'a[title]', 'h3', 'yt-formatted-string#text'],
      menuButtonFallback: ['yt-icon-button#button button', 'ytd-menu-renderer button', 'button-view-model button', 'yt-icon-button button', 'button'],
      continuation: 'ytd-continuation-item-renderer',
      // Candidates in priority order; the page also contains empty decoy "#header" elements, so a
      // candidate only counts when it actually holds the title or some buttons.
      playlistHeader: ['ytd-playlist-header-renderer', 'yt-page-header-renderer', '#page-header', 'ytd-browse[page-subtype="playlist"] #header', '#header'],
      playlistPageTitle: ['h1', '#title', 'yt-dynamic-sizing-formatted-string#text', 'yt-formatted-string#text'],
      signInButton: 'ytd-masthead a[href*="ServiceLogin"], ytd-masthead a[aria-label="Sign in"]',
      // Rows of a built-in list page (Liked videos, Watch later, Saved Shorts, Sounds): one row per video.
      listRow: 'ytd-browse[page-subtype="playlist"] #contents yt-lockup-view-model, ytd-playlist-video-renderer, ' +
        'ytd-browse[page-subtype="playlist"] #contents ytd-rich-item-renderer',
      listRowLink: 'a[href*="watch?v="], a[href*="/shorts/"]',
      listRowTitle: ['h3 a[title]', '.yt-lockup-metadata-view-model-wiz__title', '.yt-lockup-metadata-view-model__title', 'h3', '#video-title', 'a[title]'],
      // Notices shown above a list, e.g. "Unavailable videos are hidden".
      listNotice: 'ytd-alert-with-button-renderer, yt-alert-renderer, ytd-message-renderer',
    },
    labels: {
      subscribedButton: /^subscribed$/i,
      subscribedAria: /unsubscribe/i,
      subscribeButton: /^subscribe$/i,
      subscribeAria: /^subscribe( to)?\b/i,
      unsubscribeItem: /^unsubscribe$/i,
      unsubscribeConfirm: /^unsubscribe$/i,
      deleteOwnItem: /^delete( playlist)?$/i,
      deleteConfirm: /^delete( playlist)?$/i,
      // "Remove from Library" (playlists), "Remove from Your courses" (saved courses), ...
      removeSavedItem: /^(remove (this )?(playlist |course )?from (your |my )?(library|saved( playlists)?|courses?|playlists?)|unsave( playlist| course)?)$/i,
      removeConfirm: /^(remove|unsave|ok|yes)$/i,
      menuButtonAria: /more actions|action menu|more options|^more$/i,
      // "Remove from <list>" in a row's menu; the current page's own list name is added at run time.
      removeFromListItem: /^(remove from (liked videos|watch later|saved shorts|sounds)|unlike)$/i,
      // Deleted / private videos stay in a list but are hidden until the header menu shows them.
      unavailableHidden: /unavailable videos are hidden/i,
      showUnavailableItem: /^show unavailable videos$/i,
    },
    // Built-in lists: id -> name. They cannot be deleted, only emptied.
    builtinLists: { LL: 'Liked videos', WL: 'Watch later', YS: 'Saved Shorts', SS: 'Sounds', LM: 'Liked music' },
    systemPlaylistIds: ['WL', 'LL', 'LM', 'YS', 'SS'],
  };

  // ------------------------------------------------------------------ helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const textOf = (el) => (el ? norm(el.textContent) : '');
  const ariaOf = (el) => (el && el.getAttribute ? norm(el.getAttribute('aria-label')) : '');
  const isOurs = (el) => !!(el && el.closest && el.closest('#ytc-overlay'));

  function isVisible(el) {
    if (!el || !el.isConnected || isOurs(el)) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 || r.height > 0)) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  // Polls fn() until it returns something truthy. Counts intervals rather than
  // reading the clock so it behaves the same under virtual time.
  async function waitFor(fn, timeoutMs, intervalMs) {
    const step = intervalMs || 100;
    const tries = Math.max(1, Math.ceil(timeoutMs / step));
    for (let i = 0; i < tries; i++) {
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function findText(root, selectors) {
    for (const s of selectors) {
      for (const el of root.querySelectorAll(s)) {
        const t = norm(el.getAttribute && el.getAttribute('title')) || textOf(el);
        if (t) return t;
      }
    }
    return '';
  }

  // Keeps only elements that do not contain another element of the list.
  const deepest = (els) => els.filter((el) => !els.some((o) => o !== el && el.contains(o)));

  // ------------------------------------------------------------------ menus
  function visibleMenuItems() {
    const collect = (roots) => {
      const items = [];
      for (const root of roots) {
        for (const el of root.querySelectorAll(CONFIG.selectors.menuItem)) {
          if (isVisible(el) && !el.closest(CONFIG.selectors.notMenu) && !items.includes(el)) items.push(el);
        }
      }
      return deepest(items);
    };
    const hosts = Array.from(document.querySelectorAll(CONFIG.selectors.popupHost));
    const inHosts = hosts.length ? collect(hosts) : [];
    return inHosts.length ? inHosts : collect([document.body]);
  }
  const menuLabels = () => visibleMenuItems().map(textOf).filter(Boolean);
  const findMenuItem = (re) => visibleMenuItems().find((el) => re.test(textOf(el))) || null;

  async function closeMenus(trigger) {
    if (!visibleMenuItems().length) return true;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    if (await waitFor(() => visibleMenuItems().length === 0, 1000)) return true;
    if (trigger && trigger.isConnected) trigger.click();
    if (await waitFor(() => visibleMenuItems().length === 0, 1000)) return true;
    document.body.click();
    return !!(await waitFor(() => visibleMenuItems().length === 0, 1000));
  }

  // ------------------------------------------------------------------ dialogs
  const visibleDialogs = () => Array.from(document.querySelectorAll(CONFIG.selectors.dialog)).filter(isVisible);
  const dialogText = () => { const d = visibleDialogs()[0]; return d ? textOf(d).slice(0, 160) : ''; };

  function findDialogButton(re) {
    for (const d of visibleDialogs()) {
      const btns = deepest(Array.from(d.querySelectorAll(CONFIG.selectors.dialogButton)).filter(isVisible));
      const hit = btns.find((b) => re.test(textOf(b)) || re.test(ariaOf(b)));
      if (hit) return hit;
    }
    return null;
  }

  async function dismissDialogs() {
    if (!visibleDialogs().length) return;
    const cancel = findDialogButton(/^cancel$/i);
    if (cancel) cancel.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    await waitFor(() => visibleDialogs().length === 0, 1000);
  }

  // ------------------------------------------------------------------ channels
  function buttonState(btn) {
    const t = textOf(btn);
    const a = ariaOf(btn);
    if (CONFIG.labels.subscribedButton.test(t) || CONFIG.labels.subscribedAria.test(a)) return 'subscribed';
    if (CONFIG.labels.subscribeButton.test(t) || CONFIG.labels.subscribeAria.test(a)) return 'unsubscribed';
    return 'unknown';
  }

  function channelButtons(item) {
    return deepest(Array.from(item.querySelectorAll(CONFIG.selectors.channelButtons)))
      .filter((b) => !b.closest(CONFIG.selectors.notificationToggle));
  }
  function findSubscribedButton(item) {
    const subscribed = channelButtons(item).filter((b) => buttonState(b) === 'subscribed');
    return subscribed.find((b) => CONFIG.labels.subscribedAria.test(ariaOf(b))) || subscribed[0] || null;
  }

  const channelItems = () => Array.from(document.querySelectorAll(CONFIG.selectors.channelItem)).filter((el) => !isOurs(el));

  function channelKey(item) {
    const link = item.querySelector('a[href]');
    return (link && link.getAttribute('href')) || findText(item, CONFIG.selectors.channelName);
  }

  async function unsubscribeChannel(item, ctx) {
    const name = findText(item, CONFIG.selectors.channelName) || 'Unknown channel';
    const button = findSubscribedButton(item);
    if (!button) {
      const states = channelButtons(item).map(buttonState);
      const reason = states.includes('unsubscribed') ? 'already unsubscribed' : 'no "Subscribed" button found';
      return { name, status: 'skipped', reason };
    }
    item.scrollIntoView({ block: 'center' });
    await sleep(50);
    button.click();

    // Clicking "Subscribed" opens either a menu that contains "Unsubscribe" or,
    // on some layouts, the "Unsubscribe from X?" confirmation dialog directly.
    const opened = await waitFor(() => {
      const menuItem = findMenuItem(CONFIG.labels.unsubscribeItem);
      if (menuItem) return { menuItem };
      const confirm = findDialogButton(CONFIG.labels.unsubscribeConfirm);
      if (confirm) return { confirm };
      return null;
    }, ctx.waitMs);
    const labels = menuLabels();
    const dialog = dialogText();
    if (!opened) {
      await closeMenus(button);
      await dismissDialogs();
      return { name, status: 'failed', reason: 'neither an "Unsubscribe" menu item nor a confirmation dialog appeared', menuLabels: labels, dialogText: dialog };
    }
    const via = opened.menuItem ? 'menu' : 'confirmation dialog';
    if (ctx.dryRun) {
      if (opened.menuItem) await closeMenus(button); else await dismissDialogs();
      return { name, status: 'dry-run', reason: 'would unsubscribe (via ' + via + ')', menuLabels: labels, dialogText: dialog };
    }

    let confirm = opened.confirm || null;
    if (opened.menuItem) {
      opened.menuItem.click();
      // Either a confirmation dialog shows up, or the button flips straight away.
      const outcome = await waitFor(() => {
        const btn = findDialogButton(CONFIG.labels.unsubscribeConfirm);
        if (btn) return { confirm: btn };
        if (!findSubscribedButton(item)) return { flipped: true };
        return null;
      }, ctx.waitMs);
      if (!outcome) {
        await closeMenus(button);
        return { name, status: 'failed', reason: 'confirmation dialog did not appear', menuLabels: labels };
      }
      confirm = outcome.confirm || null;
    }
    if (confirm) confirm.click();

    const flipped = await waitFor(() => !item.isConnected || !findSubscribedButton(item), ctx.waitMs);
    if (!flipped) {
      await dismissDialogs();
      return { name, status: 'failed', reason: 'button still shows "Subscribed" after confirming', menuLabels: labels };
    }
    return { name, status: 'done', menuLabels: labels, dialogText: dialog };
  }

  // ------------------------------------------------------------------ playlists
  function playlistItems() {
    const sel = CONFIG.selectors.playlistItem;
    return Array.from(document.querySelectorAll(sel))
      .filter((el) => !isOurs(el))
      .filter((el) => !(el.parentElement && el.parentElement.closest(sel)))   // outermost wrapper only
      .filter((el) => el.querySelector(CONFIG.selectors.playlistLink));
  }

  function playlistId(item) {
    const link = item.querySelector(CONFIG.selectors.playlistLink);
    const href = link ? link.getAttribute('href') : '';
    const m = /[?&]list=([^&#]+)/.exec(href || '');
    return m ? decodeURIComponent(m[1]) : '';
  }

  function findMenuButton(root) {
    const byAria = Array.from(root.querySelectorAll('button, yt-icon-button, tp-yt-paper-icon-button, [role="button"]'))
      .find((b) => CONFIG.labels.menuButtonAria.test(ariaOf(b)));
    if (byAria) return byAria;
    for (const s of CONFIG.selectors.menuButtonFallback) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function choosePlaylistAction(ctx) {
    const del = findMenuItem(CONFIG.labels.deleteOwnItem);
    const rem = findMenuItem(CONFIG.labels.removeSavedItem);
    if (del) {
      if (!ctx.deleteOwnPlaylists) return { skip: 'own playlist (deleting your own playlists is turned off)' };
      return { el: del, kind: 'delete', confirm: CONFIG.labels.deleteConfirm, describe: 'delete playlist' };
    }
    if (rem) {
      if (!ctx.removeSavedPlaylists) return { skip: 'saved playlist (removing saved playlists is turned off)' };
      return { el: rem, kind: 'remove', confirm: CONFIG.labels.removeConfirm, describe: 'remove from library' };
    }
    return { skip: 'no delete / remove option in its menu', fallback: true };
  }

  const playlistUrl = (id) => (/^https?:$/.test(location.protocol) ? location.origin : 'https://www.youtube.com') + '/playlist?list=' + encodeURIComponent(id);

  // YouTube's grids recycle tiles: after a delete the same element is re-bound to
  // the next item, so "gone" means disconnected OR now showing a different id.
  const itemGone = (item, id, idOf) => !item.isConnected || !isVisible(item) || idOf(item) !== id;

  async function runPlaylistAction(action, item, ctx) {
    const id = playlistId(item);
    action.el.click();
    const outcome = await waitFor(() => {
      const confirm = findDialogButton(action.confirm);
      if (confirm) return { confirm };
      if (itemGone(item, id, playlistId)) return { gone: true };
      return null;
    }, ctx.waitMs);
    if (outcome && outcome.confirm) outcome.confirm.click();
    const gone = await waitFor(() => itemGone(item, id, playlistId), ctx.waitMs);
    if (gone) return { ok: true };
    if (visibleDialogs().length) {
      await dismissDialogs();
      return { ok: false, reason: 'confirmation dialog did not close' };
    }
    return { ok: true, note: 'action sent; the item did not disappear from the list, refresh the page to verify' };
  }

  async function processPlaylist(item, ctx) {
    const id = playlistId(item);
    const name = findText(item, CONFIG.selectors.playlistTitle) || id || 'Unknown playlist';
    if (CONFIG.systemPlaylistIds.includes(id)) return { name, id, status: 'skipped', reason: 'built-in YouTube list (cannot be deleted; it can only be emptied)' };
    const menuButton = findMenuButton(item);
    if (!menuButton) {
      // Saved (other people's) playlists have no menu in the list view; handle them on their own page.
      return { name, id, status: 'skipped', reason: 'no menu button in the list view (will retry on its own page)', fallback: !!id };
    }
    item.scrollIntoView({ block: 'center' });
    await sleep(50);
    menuButton.click();

    const opened = await waitFor(() => visibleMenuItems().length > 0, ctx.waitMs);
    const labels = menuLabels();
    if (!opened) return { name, id, status: 'failed', reason: 'menu did not open' };
    if (playlistId(item) !== id) {
      await closeMenus(menuButton);
      return { name, id, status: 'retry', reason: 'tile changed while its menu was opening' };
    }

    const action = choosePlaylistAction(ctx);
    if (action.skip) {
      await closeMenus(menuButton);
      const out = { name, id, status: 'skipped', reason: action.skip, menuLabels: labels };
      if (action.fallback && id) { out.fallback = true; out.reason += ' (will retry on its own page)'; }
      return out;
    }
    if (ctx.dryRun) {
      await closeMenus(menuButton);
      return { name, id, status: 'dry-run', reason: 'would ' + action.describe, menuLabels: labels };
    }
    const r = await runPlaylistAction(action, item, ctx);
    if (!r.ok) return { name, id, status: 'failed', reason: r.reason, menuLabels: labels };
    return { name, id, status: 'done', reason: action.describe + (r.note ? ' (' + r.note + ')' : ''), menuLabels: labels };
  }

  // ------------------------------------------------------------------ built-in lists (Liked videos, Watch later, Saved Shorts, Sounds)
  function listRows() {
    const sel = CONFIG.selectors.listRow;
    return Array.from(document.querySelectorAll(sel))
      .filter((el) => !isOurs(el))
      .filter((el) => !(el.parentElement && el.parentElement.closest(sel)))
      .filter((el) => el.querySelector(CONFIG.selectors.listRowLink));
  }

  function rowVideoId(item) {
    const link = item.querySelector(CONFIG.selectors.listRowLink);
    const href = (link && link.getAttribute('href')) || '';
    const m = /[?&]v=([^&#]+)/.exec(href) || /\/shorts\/([^?&#/]+)/.exec(href);
    return m ? m[1] : '';
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Which list page is this? (id from the URL, display name from the header or the known ids)
  function currentList() {
    const m = /[?&]list=([^&#]+)/.exec(location.search || '');
    const id = m ? decodeURIComponent(m[1]) : '';
    const header = playlistHeader();
    const title = (header && findText(header, CONFIG.selectors.playlistPageTitle)) || CONFIG.builtinLists[id] || id || 'this list';
    const re = new RegExp('^(remove from ' + escapeRe(title) + '|' + CONFIG.labels.removeFromListItem.source.replace(/^\^\(|\)\$$/g, '') + ')$', 'i');
    return { id, title, removeRe: re };
  }

  async function removeFromList(item, ctx) {
    const id = rowVideoId(item);
    const name = findText(item, CONFIG.selectors.listRowTitle) || id || 'Unknown video';
    const listName = ctx.list ? ctx.list.title : 'this list';
    const menuButton = findMenuButton(item);
    if (!menuButton) return { name, id, status: 'failed', reason: 'no menu button found on this row' };
    item.scrollIntoView({ block: 'center' });
    await sleep(50);
    menuButton.click();

    const removeRe = ctx.list ? ctx.list.removeRe : CONFIG.labels.removeFromListItem;
    const remove = await waitFor(() => findMenuItem(removeRe), ctx.waitMs);
    const labels = menuLabels();
    if (rowVideoId(item) !== id) {
      // The list re-rendered while the menu was opening; this menu now belongs to another video.
      await closeMenus(menuButton);
      return { name, id, status: 'retry', reason: 'row changed while its menu was opening' };
    }
    if (!remove) {
      await closeMenus(menuButton);
      return { name, id, status: labels.length ? 'skipped' : 'failed', reason: labels.length ? 'no "Remove from ' + listName + '" option in its menu' : 'menu did not open', menuLabels: labels };
    }
    if (ctx.dryRun) {
      await closeMenus(menuButton);
      return { name, id, status: 'dry-run', reason: 'would remove from ' + listName, menuLabels: labels };
    }
    const since = performance.now();
    remove.click();
    // Watch later drops (or re-binds) the row; Liked videos, Saved Shorts and Sounds give no DOM feedback
    // at all. The menu closing is the one signal every list gives, so once it has closed without a
    // dialog we only allow a short grace period for the row to go instead of the full wait.
    let outcome = await waitFor(() => {
      if (itemGone(item, id, rowVideoId)) return 'gone';
      if (visibleDialogs().length) return 'dialog';
      if (!visibleMenuItems().length) return 'closed';
      return null;
    }, ctx.waitMs);
    if (outcome === 'dialog') {
      await dismissDialogs();
      return { name, id, status: 'failed', reason: 'an unexpected dialog appeared', menuLabels: labels };
    }
    if (!outcome) {
      await closeMenus(menuButton);
      return { name, id, status: 'failed', reason: 'the menu stayed open after choosing "Remove"', menuLabels: labels };
    }
    // What did YouTube actually say? The row is gone from the page either way.
    const verdict = ctx.net ? await ctx.net.verdict(since, CONFIG.removalResponseWaitMs) : null;
    if (verdict && !verdict.ok) {
      return { name, id, status: 'failed', rejected: true, reason: 'YouTube rejected the removal (HTTP ' + verdict.status + '); the video is still in ' + listName, menuLabels: labels };
    }
    if (verdict) return { name, id, status: 'done', reason: 'removed from ' + listName + ' (confirmed by YouTube)', menuLabels: labels };
    if (outcome === 'closed' && await waitFor(() => itemGone(item, id, rowVideoId), CONFIG.rowGoneGraceMs)) outcome = 'gone';
    if (outcome === 'gone') return { name, id, status: 'done', reason: 'removed from ' + listName, menuLabels: labels };
    return { name, id, status: 'done', reason: 'removed from ' + listName + ' (row still shown; refresh to verify)', menuLabels: labels };
  }

  // Watches the performance timeline for the request YouTube sends when a video is removed and
  // reports its HTTP status. Resource entries are visible from a content script too.
  function watchRemovalRequests() {
    const seen = [];
    let observer = null;
    let hits = 0;
    let misses = 0;
    if (typeof PerformanceObserver === 'function') {
      try {
        observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (CONFIG.removalRequest.test(e.name)) seen.push({ startTime: e.startTime, status: Number(e.responseStatus) || 0 });
          }
        });
        observer.observe({ type: 'resource', buffered: false });
      } catch (e) { observer = null; }
    }
    return {
      // Give up on the signal only if the first removals never show a request at all (not every browser exposes them).
      supported: () => !!observer && !(misses >= 3 && hits === 0),
      // The status of the first removal request that started after `since` (a performance.now() reading).
      async verdict(since, maxWaitMs) {
        if (!this.supported()) return null;
        const found = await waitFor(() => seen.find((r) => r.startTime >= since) || null, maxWaitMs, 50);
        if (!found) { misses++; return null; }
        hits++;
        if (!found.status) return null;   // request seen but its status is not exposed
        return { status: found.status, ok: found.status >= 200 && found.status < 300 };
      },
      stop() { if (observer) observer.disconnect(); },
    };
  }

  // The "1,234 videos" count in the list header; 0 when it shows none (empty list).
  function headerVideoCount() {
    const header = playlistHeader();
    const m = header && /(\d[\d,]*)\s+videos?/i.exec(textOf(header));   // "3,799 videos", also when glued to the next element
    return m ? Number(m[1].replace(/,/g, '')) : 0;
  }

  // Deleted and private videos are still saved in a list but hidden from it ("Unavailable videos are
  // hidden"); the header's menu can show them so they can be removed like any other row.
  async function showUnavailableVideos(ctx) {
    const notice = Array.from(document.querySelectorAll(CONFIG.selectors.listNotice)).some((el) => CONFIG.labels.unavailableHidden.test(textOf(el)));
    if (!notice) return false;
    const header = playlistHeader();
    const menuButton = header && findMenuButton(header);
    if (!menuButton) return false;
    menuButton.click();
    const item = await waitFor(() => findMenuItem(CONFIG.labels.showUnavailableItem), ctx.waitMs);
    if (!item) { await closeMenus(menuButton); return false; }
    item.click();
    await closeMenus(menuButton);
    ctx.log('Showing unavailable (deleted / private) videos so they can be removed too.');
    await waitFor(() => listRows().length > 0, ctx.initialWaitMs, 200);
    return true;
  }

  async function runClearList(taskName, ctx) {
    await waitFor(() => listRows().length > 0 || playlistHeader(), ctx.initialWaitMs, 200);
    ctx.list = currentList();
    ctx.log('List: ' + ctx.list.title + (ctx.list.id ? ' (' + ctx.list.id + ')' : ''));
    await showUnavailableVideos(ctx);
    ctx.net = watchRemovalRequests();
    let summary;
    try {
      summary = await processAll(taskName, ctx, listRows, rowVideoId, removeFromList, { settle: true });
    } finally {
      ctx.net.stop();
    }
    // YouTube sometimes stops serving more rows long before the list is empty (seen after ~1,500
    // removals on Watch later); the header still says how many are left and a reload brings them back.
    const remaining = ctx.dryRun || summary.stopped || ctx.maxItems ? 0 : headerVideoCount();
    if (remaining > 0) {
      summary.remaining = remaining;
      ctx.log('The list still shows ' + remaining + ' video(s); reload the page and run again to continue.', 'muted');
    }
    return summary;
  }

  // ------------------------------------------------------------------ single playlist page
  function playlistHeader() {
    for (const sel of CONFIG.selectors.playlistHeader) {
      for (const el of document.querySelectorAll(sel)) {
        if (isOurs(el)) continue;
        if (el.querySelector('button, tp-yt-paper-button') && textOf(el)) return el;
      }
    }
    return null;
  }

  function findSavedToggle(header) {
    return Array.from(header.querySelectorAll('button, tp-yt-paper-button, yt-icon-button, [role="button"]'))
      .filter((b) => !b.closest(CONFIG.selectors.menuItem))
      .find((b) => CONFIG.labels.removeSavedItem.test(ariaOf(b)) || CONFIG.labels.removeSavedItem.test(textOf(b))) || null;
  }

  async function processPlaylistPage(ctx) {
    const m = /[?&]list=([^&#]+)/.exec(location.search || '');
    const id = m ? decodeURIComponent(m[1]) : '';
    const header = await waitFor(playlistHeader, ctx.initialWaitMs);
    if (!header) return { name: id || 'Unknown playlist', id, status: 'failed', reason: 'playlist header not found on this page' };
    const name = findText(header, CONFIG.selectors.playlistPageTitle) || id || 'Unknown playlist';
    if (CONFIG.systemPlaylistIds.includes(id)) return { name, id, status: 'skipped', reason: 'built-in YouTube list (cannot be deleted)' };
    if (!matchesOnly(ctx, id, header)) return { name, id, status: 'skipped', reason: 'not in the "only" list' };

    // 1) Saved playlists usually have a bookmark toggle right in the header.
    const toggle = findSavedToggle(header);
    if (toggle) {
      if (!ctx.removeSavedPlaylists) return { name, id, status: 'skipped', reason: 'saved playlist (removing saved playlists is turned off)' };
      if (ctx.dryRun) return { name, id, status: 'dry-run', reason: 'would remove from library (header button: "' + (ariaOf(toggle) || textOf(toggle)) + '")' };
      toggle.click();
      const confirm = await waitFor(() => findDialogButton(CONFIG.labels.removeConfirm), 1500);
      if (confirm) confirm.click();
      const toggled = await waitFor(() => !toggle.isConnected || !(CONFIG.labels.removeSavedItem.test(ariaOf(toggle)) || CONFIG.labels.removeSavedItem.test(textOf(toggle))), ctx.waitMs);
      if (!toggled) return { name, id, status: 'failed', reason: 'header button did not change after clicking' };
      return { name, id, status: 'done', reason: 'removed from library' };
    }

    // 2) Otherwise use the header's "More actions" menu.
    const menuButton = findMenuButton(header);
    if (!menuButton) return { name, id, status: 'skipped', reason: 'no save toggle or menu button in the playlist header' };
    menuButton.click();
    const opened = await waitFor(() => visibleMenuItems().length > 0, ctx.waitMs);
    const labels = menuLabels();
    if (!opened) return { name, id, status: 'failed', reason: 'header menu did not open' };
    const action = choosePlaylistAction(ctx);
    if (action.skip) {
      await closeMenus(menuButton);
      return { name, id, status: 'skipped', reason: action.skip, menuLabels: labels };
    }
    if (ctx.dryRun) {
      await closeMenus(menuButton);
      return { name, id, status: 'dry-run', reason: 'would ' + action.describe, menuLabels: labels };
    }
    action.el.click();
    // Give a confirmation dialog a moment to show up; some actions apply directly.
    const confirm = await waitFor(() => findDialogButton(action.confirm), Math.min(ctx.waitMs, 2500));
    if (confirm) {
      confirm.click();
      const closed = await waitFor(() => visibleDialogs().length === 0, ctx.waitMs);
      if (!closed) {
        await dismissDialogs();
        return { name, id, status: 'failed', reason: 'confirmation dialog did not close', menuLabels: labels };
      }
    } else if (visibleDialogs().length) {
      await dismissDialogs();
      return { name, id, status: 'failed', reason: 'an unexpected dialog appeared', menuLabels: labels };
    } else {
      await sleep(500); // let the request go out
    }
    await closeMenus(menuButton);
    return { name, id, status: 'done', reason: action.describe, menuLabels: labels };
  }

  // ------------------------------------------------------------------ engine
  const state = { running: false, stopRequested: false };

  function makeContext(options, reporter) {
    const o = options || {};
    const r = reporter || {};
    return {
      dryRun: !!o.dryRun,
      deleteOwnPlaylists: !!o.deleteOwnPlaylists,
      removeSavedPlaylists: o.removeSavedPlaylists !== false,
      waitMs: Number(o.waitMs) > 0 ? Number(o.waitMs) : CONFIG.waitMs,
      delayMs: Number(o.delayMs) >= 0 ? Number(o.delayMs) : CONFIG.delayMs,
      loadMoreWaitMs: Number(o.loadMoreWaitMs) > 0 ? Number(o.loadMoreWaitMs) : CONFIG.loadMoreWaitMs,
      maxItems: Number(o.maxItems) > 0 ? Number(o.maxItems) : 0,
      initialWaitMs: Number(o.initialWaitMs) > 0 ? Number(o.initialWaitMs) : CONFIG.initialWaitMs,
      // Only handle items whose id / link / visible text contains one of these strings (case-insensitive).
      only: (Array.isArray(o.only) ? o.only : String(o.only || '').split(',')).map((s) => norm(s).toLowerCase()).filter(Boolean),
      log: (msg, level) => { try { if (r.log) r.log(msg, level || 'info'); } catch (e) { /* ignore */ } },
      progress: (info) => { try { if (r.progress) r.progress(info); } catch (e) { /* ignore */ } },
      shouldStop: () => state.stopRequested || !!(r.shouldStop && r.shouldStop()),
    };
  }

  function matchesOnly(ctx, key, item) {
    if (!ctx.only.length) return true;
    const hay = ((key || '') + ' ' + textOf(item)).toLowerCase();
    return ctx.only.some((s) => hay.includes(s));
  }

  function describe(item) {
    const bits = [item.status.toUpperCase(), item.name];
    if (item.reason) bits.push('- ' + item.reason);
    return bits.join(' ');
  }

  // Waits until the ids shown by the list stop changing (YouTube re-renders rows after a removal).
  async function settleList(selectItems, keyOf, maxMs) {
    let prev = null;
    for (let i = 0; i < Math.ceil(maxMs / 250); i++) {
      const keys = selectItems().map(keyOf).join('|');
      if (prev !== null && keys === prev) return;
      prev = keys;
      await sleep(250);
    }
  }

  async function processAll(task, ctx, selectItems, keyOf, processOne, opts) {
    const settle = !!(opts && opts.settle);
    const summary = { task, dryRun: ctx.dryRun, processed: 0, succeeded: 0, failed: 0, skipped: 0, filteredOut: 0, retries: 0, stopped: false, items: [] };
    const seen = new Set();
    const seenEls = new WeakSet();
    let idleRounds = 0;
    let acted = 0;
    let pause = ctx.delayMs;   // grows when YouTube rejects removals for coming too fast

    await waitFor(() => selectItems().length > 0 || document.querySelector(CONFIG.selectors.continuation), ctx.initialWaitMs, 200);

    const record = (result) => {
      summary.items.push(result);
      summary.processed++;
      if (result.status === 'done') summary.succeeded++;
      else if (result.status === 'failed') summary.failed++;
      else if (result.status === 'skipped') summary.skipped++;
      if (result.status !== 'skipped') acted++;
      ctx.log(describe(result), result.status === 'failed' ? 'error' : result.status === 'skipped' ? 'muted' : 'info');
      ctx.progress({ task, processed: summary.processed, succeeded: summary.succeeded, failed: summary.failed, skipped: summary.skipped, current: result.name });
    };

    for (;;) {
      if (ctx.shouldStop()) { summary.stopped = true; break; }
      if (ctx.maxItems && acted >= ctx.maxItems) { ctx.log('Reached the limit of ' + ctx.maxItems + ' items.'); break; }

      // An item is pending when its id has not been handled yet. Elements are
      // deliberately NOT used as the identity: YouTube re-binds the same tile to
      // another item after a deletion. Only id-less items fall back to identity.
      const isPending = (el) => { const k = keyOf(el); return k ? !seen.has(k) : !seenEls.has(el); };
      const pending = selectItems().filter(isPending);
      if (pending.length) {
        idleRounds = 0;
        for (const item of pending) {
          if (ctx.shouldStop()) { summary.stopped = true; break; }
          if (ctx.maxItems && acted >= ctx.maxItems) break;
          if (!item.isConnected) continue;            // dropped by a re-render in the meantime
          const key = keyOf(item);
          if (key && seen.has(key)) continue;         // re-bound to an item we already handled
          if (key) seen.add(key); else seenEls.add(item);
          if (!matchesOnly(ctx, key, item)) { summary.filteredOut++; continue; }
          let result;
          const startedAt = Date.now();
          try {
            result = await processOne(item, ctx);
          } catch (e) {
            result = { name: 'Unknown', status: 'failed', reason: 'unexpected error: ' + (e && e.message || e) };
          }
          result.ms = Date.now() - startedAt;
          if (result.status === 'retry') {
            // Not handled after all: forget the id so the item is picked up again wherever it now is.
            if (key) seen.delete(key); else seenEls.delete(item);
            summary.retries++;
            ctx.log('Retrying ' + result.name + ' (' + result.reason + ')', 'muted');
            if (settle) await settleList(selectItems, keyOf, 4000);
            break;   // re-query the list from scratch
          }
          record(result);
          if (result.rejected) {
            pause = Math.min(pause < CONFIG.rejectedPauseMs ? CONFIG.rejectedPauseMs : pause + CONFIG.rejectedPauseStepMs, CONFIG.maxPauseMs);
            ctx.log('YouTube is rejecting edits that come too fast; slowing down to ' + (pause / 1000).toFixed(1) + 's between items.', 'muted');
          }
          if (result.status === 'done' && settle && !ctx.dryRun) await settleList(selectItems, keyOf, 4000);
          if (result.status !== 'skipped') await sleep(pause);
        }
        continue;
      }

      // Nothing left on screen: scroll down so YouTube loads the next batch.
      const before = selectItems().length;
      window.scrollTo(0, document.documentElement.scrollHeight);
      const more = await waitFor(() => selectItems().length > before, ctx.loadMoreWaitMs, 150);
      if (more) { idleRounds = 0; continue; }
      idleRounds++;
      const spinner = document.querySelector(CONFIG.selectors.continuation);
      const limit = spinner ? CONFIG.scrollIdleRounds * 2 : CONFIG.scrollIdleRounds;
      if (idleRounds >= limit) break;
    }
    window.scrollTo(0, 0);
    // Removals YouTube rejected: their rows are gone from the page but the videos are still in the
    // list, so they can only be retried after a reload.
    summary.rejected = summary.items.filter((i) => i.rejected).map((i) => ({ id: i.id, name: i.name }));
    return summary;
  }

  const TASKS = {
    unsubscribe: {
      title: 'Unsubscribing from channels',
      run: (ctx) => processAll('unsubscribe', ctx, channelItems, channelKey, unsubscribeChannel),
    },
    playlists: {
      title: 'Cleaning up playlists',
      run: async (ctx) => {
        const summary = await processAll('playlists', ctx, playlistItems, playlistId, processPlaylist, { settle: true });
        summary.fallback = summary.items.filter((i) => i.fallback).map((i) => ({ id: i.id, name: i.name, url: playlistUrl(i.id) }));
        return summary;
      },
    },
    unlike: {
      title: 'Removing likes',
      run: (ctx) => runClearList('unlike', ctx),
    },
    'clear-list': {
      title: 'Emptying this list',
      run: (ctx) => runClearList('clear-list', ctx),
    },
    'playlist-page': {
      title: 'Cleaning up this playlist',
      run: async (ctx) => {
        const summary = { task: 'playlist-page', dryRun: ctx.dryRun, processed: 0, succeeded: 0, failed: 0, skipped: 0, stopped: false, items: [] };
        let result;
        try { result = await processPlaylistPage(ctx); }
        catch (e) { result = { name: 'Unknown playlist', status: 'failed', reason: 'unexpected error: ' + (e && e.message || e) }; }
        summary.items.push(result);
        summary.processed = 1;
        if (result.status === 'done') summary.succeeded = 1;
        else if (result.status === 'failed') summary.failed = 1;
        else if (result.status === 'skipped') summary.skipped = 1;
        ctx.log(describe(result), result.status === 'failed' ? 'error' : result.status === 'skipped' ? 'muted' : 'info');
        return summary;
      },
    },
  };

  async function run(task, options, reporter) {
    if (!TASKS[task]) throw new Error('Unknown task: ' + task);
    if (state.running) throw new Error('A run is already in progress');
    state.running = true;
    state.stopRequested = false;
    const ctx = makeContext(options, reporter);
    ctx.log((ctx.dryRun ? '[DRY RUN] ' : '') + TASKS[task].title + (ctx.only.length ? ' (only: ' + ctx.only.join(', ') + ')' : '') + '...');
    if (document.querySelector(CONFIG.selectors.signInButton)) ctx.log('Warning: you do not seem to be signed in to YouTube.', 'error');
    try {
      const summary = await TASKS[task].run(ctx);
      summary.finishedAt = Date.now();
      ctx.log('Finished: ' + summary.succeeded + ' done, ' + summary.failed + ' failed, ' + summary.skipped + ' skipped' + (summary.stopped ? ' (stopped early)' : '') + '.'
        + (summary.rejected && summary.rejected.length ? ' ' + summary.rejected.length + ' removal(s) were rejected by YouTube; reload the page and run again to retry them.' : ''));
      return summary;
    } finally {
      state.running = false;
    }
  }

  function stop() { state.stopRequested = true; }

  window.YTCleaner = { __installed: true, version: VERSION, CONFIG, run, stop, isRunning: () => state.running };

  // ------------------------------------------------------------------ on-page overlay + extension messaging
  // Built with DOM APIs only (no innerHTML): YouTube enforces Trusted Types.
  const OVERLAY_CSS =
    '#ytc-overlay{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:360px;max-width:calc(100vw - 32px);' +
    'background:#1f1f1f;color:#f1f1f1;font:13px/1.4 Roboto,Arial,sans-serif;border:1px solid #3f3f3f;border-radius:12px;' +
    'box-shadow:0 8px 30px rgba(0,0,0,.5);padding:14px 16px;box-sizing:border-box}' +
    '#ytc-overlay h2{margin:0 0 6px;font-size:15px;font-weight:600;display:flex;justify-content:space-between;align-items:center}' +
    '#ytc-overlay .ytc-badge{font-size:11px;color:#ffb74d}' +
    '#ytc-overlay .ytc-status{color:#aaa;margin-bottom:8px}' +
    '#ytc-overlay .ytc-log{max-height:150px;overflow:auto;background:#121212;border-radius:8px;padding:8px;margin-bottom:10px;' +
    'font-family:ui-monospace,Menlo,monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-word}' +
    '#ytc-overlay .ytc-log div{padding:1px 0}' +
    '#ytc-overlay .ytc-log .error{color:#ff8a80}#ytc-overlay .ytc-log .muted{color:#8a8a8a}' +
    '#ytc-overlay button{background:#ff4e45;color:#fff;border:0;border-radius:18px;padding:7px 16px;font-weight:600;cursor:pointer}' +
    '#ytc-overlay button.secondary{background:#3f3f3f}';

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  const overlay = {
    el: null,
    ensure() {
      if (this.el && this.el.isConnected) return this.el;
      const root = el('div');
      root.id = 'ytc-overlay';
      const style = el('style');
      style.textContent = OVERLAY_CSS;
      const h2 = el('h2');
      h2.append(el('span', null, 'YouTube Cleaner'), el('span', 'ytc-badge', ''));
      const actions = el('div', 'ytc-actions');
      const stopBtn = el('button', 'ytc-stop', 'Stop');
      stopBtn.type = 'button';
      stopBtn.addEventListener('click', () => { stop(); this.setStatus('Stopping after the current item...'); });
      actions.appendChild(stopBtn);
      root.append(style, h2, el('div', 'ytc-status', 'Starting...'), el('div', 'ytc-log'), actions);
      document.documentElement.appendChild(root);
      this.el = root;
      return root;
    },
    setStatus(text) { this.ensure().querySelector('.ytc-status').textContent = text; },
    setBadge(text) { this.ensure().querySelector('.ytc-badge').textContent = text; },
    log(msg, level) {
      const box = this.ensure().querySelector('.ytc-log');
      box.appendChild(el('div', level || 'info', msg));
      while (box.children.length > 60) box.removeChild(box.firstChild);
      box.scrollTop = box.scrollHeight;
    },
    finish(text) {
      const root = this.ensure();
      this.setStatus(text);
      const actions = root.querySelector('.ytc-actions');
      actions.textContent = '';
      const close = el('button', 'secondary ytc-close', 'Close');
      close.type = 'button';
      close.addEventListener('click', () => root.remove());
      actions.appendChild(close);
    },
  };

  const hasChrome = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage;
  if (hasChrome) {
    const send = (msg) => { try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) { /* popup closed, worker asleep */ } };

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'ytc:ping') { sendResponse({ ok: true, running: state.running, version: VERSION }); return; }
      if (msg.type === 'ytc:stop') { stop(); overlay.setStatus('Stopping after the current item...'); sendResponse({ ok: true }); return; }
      if (msg.type === 'ytc:run') {
        if (state.running) { sendResponse({ ok: false, error: 'already running' }); return; }
        sendResponse({ ok: true });
        const task = msg.task;
        const options = msg.options || {};
        overlay.ensure();
        overlay.setBadge(options.dryRun ? 'DRY RUN' : '');
        overlay.setStatus(TASKS[task] ? TASKS[task].title + '...' : 'Running...');
        const reporter = {
          log: (m, level) => { overlay.log(m, level); send({ type: 'ytc:log', task, message: m, level }); },
          progress: (info) => {
            overlay.setStatus((TASKS[task] ? TASKS[task].title : task) + ': ' + info.processed + ' seen, ' + info.succeeded + ' done, ' + info.failed + ' failed, ' + info.skipped + ' skipped');
            send({ type: 'ytc:progress', task, info });
          },
        };
        run(task, options, reporter)
          .then((summary) => {
            overlay.finish('Finished ' + (TASKS[task] ? TASKS[task].title.toLowerCase() : task) + '. ' + summary.succeeded + ' done, ' + summary.failed + ' failed, ' + summary.skipped + ' skipped.');
            send({ type: 'ytc:done', task, summary });
          })
          .catch((err) => {
            overlay.log('Error: ' + (err && err.message || err), 'error');
            overlay.finish('Stopped with an error.');
            send({ type: 'ytc:done', task, error: String(err && err.message || err) });
          });
        return;
      }
    });
  }
})();
