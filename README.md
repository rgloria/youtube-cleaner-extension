# YouTube Cleaner (Chrome extension)

Unsubscribes you from **every** YouTube channel and removes **every** saved playlist from your library, in one run, with a dry-run mode so you can see exactly what it would do before it does it.

It works by driving the normal YouTube pages the same way you would: it opens each channel's **Subscribed** menu and picks **Unsubscribe**, and opens each playlist's **⋮** menu and picks **Remove from library** (or **Delete playlist**, if you turn that on). Nothing leaves your browser; there is no server and no API key.

## Install (unpacked)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder (`youtube-cleaner-extension`).
4. Pin the red icon from the puzzle-piece menu if you like.

Make sure you are signed in to YouTube in the same Chrome profile.

## Use

1. Click the extension icon.
2. Pick what to do:
   - **Unsubscribe from all channels**
   - **Unlike all videos** (empties your Liked videos list)
   - **Empty Watch later, Saved Shorts and Sounds** (these built-in lists cannot be deleted, so their items are removed one by one)
   - **Remove all saved playlists** (other people's playlists you saved)
   - **Also delete playlists I created** (off by default; permanent)
3. Leave **Dry run** on and click **Start dry run**. A YouTube tab opens, the extension walks through the pages and a small panel in the corner of the page shows what it finds and would do. Nothing is changed.
4. Check the log. If everything looks right, open the popup again, turn **Dry run** off, tick the confirmation box and click **Start (make changes)**.
5. You can press **Stop** in the popup or in the on-page panel at any time. It stops after the item it is on.

Under **Advanced** you can slow it down (pause between items), cap how many items it handles per task, or restrict a run to items whose name or ID contains a given text. Combining the last two is the safest way to try a real run on a single known channel or playlist.

## Verified against the live site (Oct 2026)

- Subscriptions page: clicking **Subscribed** opens the "Unsubscribe from X?" dialog directly; the bell next to it is left alone. Unsubscribing one channel was confirmed server-side (it disappeared from the list after a reload).
- Playlists page: your own playlists have a **⋮** menu with **Delete** / **Edit**; **Delete** applies immediately with no confirmation. Verified for real on throwaway playlists: two adjacent ones were deleted in one run and a saved playlist was removed from the library through its own page.
- Saved **courses** (playlists from channels that YouTube labels as courses) use YouTube's older playlist header with a **Remove from Your courses** toggle; verified for real on two of them. The page contains several empty decoy `#header` elements before the real header, which the extension now skips.
- **Liked videos, Watch later, Saved Shorts and Sounds** are built-in YouTube lists that cannot be deleted by anyone. "Unlike all videos" empties Liked videos; "Empty Watch later, Saved Shorts and Sounds" empties the other three. Verified for real on 2026-10-24: all four lists read "No videos" on a fresh page load afterwards. Watch later went from about 5,000 videos (223 of them hidden unavailable ones) to empty over several reload passes; Liked videos held well over 5,000 likes (the header is capped at 5,000) and the final reload loop alone confirmed 8,507 removals in 10 passes with nothing rejected.
- After a removal, YouTube re-renders the following rows with a lag, and a row's menu acts on whatever the row holds when the item is clicked. The extension re-checks a row's identity after its menu opens and retries if it changed, then waits for the list to settle before moving on.
- Liked videos, Saved Shorts and Sounds give no feedback at all when a video is removed: the row stays, there is no toast, only YouTube's own `like/removelike` request goes out. Watch later does drop the row. The extension therefore reads the HTTP status of YouTube's own removal request (`like/removelike`, `browse/edit_playlist`) from the page's performance timeline, which a content script can see, and reports the item as "confirmed by YouTube" or as rejected. Where that signal is unavailable it falls back to the menu closing plus a short grace period for the row to go ("refresh to verify"). If the menu is still open after the wait, the click did not take and the item is reported as failed. (An earlier version waited the full timeout per row, about six seconds each, which made Liked videos take hours.)
- **YouTube accepts about one edit per playlist every two seconds.** A faster `browse/edit_playlist` call gets HTTP 409 ("ABORTED") while the page still drops the row as if it had worked. A first full run on Watch later counted 3,657 removals of which only about 1,200 were real. Now a rejected removal counts as failed, the run slows to roughly one removal every two seconds after the first rejection, and the background worker reloads the list and runs it again until nothing is rejected, for as long as each pass still removes something. The popup shows later passes as "(pass 2)" and so on. Liked videos (`like/removelike`) has no such limit.
- Deleted and private videos stay in a list but are hidden ("Unavailable videos are hidden"), and they keep the header count up: Watch later still said 223 videos with nothing listed. The extension opens the header's **Action menu**, chooses **Show unavailable videos** and removes those rows like any other (verified live).
- YouTube also stops serving more rows long before a big list is empty (Watch later stalled after about 1,500 removals in one go) while the header still shows the count. A run that ends like that reports how many videos the header still shows, and the background worker reloads the list for another pass, the same way as for rejected removals (not in a dry run and not when "stop after N items" is set).
- The Liked videos header keeps showing "5,000 videos" while older likes are being removed: YouTube only lists the 5,000 most recent likes, so the count only starts dropping once fewer than that remain.
- YouTube does not remove a deleted playlist's tile from the page. It re-binds that same tile to the next playlist and drops the last tile instead. The extension therefore tracks what it has handled by playlist ID, never by page element (an earlier version did, which made a real run stop after the first few deletions). Liked-video rows behave the same way and are handled the same way.

## What it touches

| Page | Action |
| --- | --- |
| `youtube.com/feed/channels` | For each channel showing **Subscribed**: menu → **Unsubscribe** → confirm. |
| `youtube.com/playlist?list=LL` | For each liked video: **⋮** menu → **Remove from Liked videos**. Loads the list 100 at a time while scrolling. |
| `youtube.com/playlist?list=WL`, `YS`, `SS` | Same, with **Remove from Watch later** / **Remove from Saved Shorts** / **Remove from Sounds**. |
| `youtube.com/feed/playlists` | For each playlist: menu → **Delete** (own, only if enabled). Saved playlists and courses have no menu here and are handled on their own page. Liked videos, Watch later, Saved Shorts and Sounds are built-in lists and are skipped. |
| `youtube.com/playlist?list=…` | Used for playlists with no usable menu in the list (saved playlists): clicks the header's **Remove from Library** toggle, or **Delete playlist** in the header's **More actions** menu. |

Your own playlists are never deleted unless you explicitly enable it. Playlists, subscriptions and anything else that is removed cannot be restored by this tool.

## If YouTube changes its wording or layout

Everything that depends on YouTube's markup and button text is in the `CONFIG` object at the top of `content.js` (selectors and label regular expressions). Run a dry run first: the log prints the menu labels it saw for each item, so you can see at a glance which pattern needs adjusting. After editing, click the reload arrow for the extension on `chrome://extensions`.

## Development

```
npm test
```

The tests drive the real `content.js` against a mock of YouTube's DOM in headless Chrome (no npm dependencies). Set `CHROME_BIN` if Chrome is not at the default macOS path. Icons are generated with `node scripts/make-icons.mjs`.

Files:

- `manifest.json` – Manifest V3 definition.
- `background.js` – service worker that opens the tab, navigates between pages and sequences the tasks.
- `content.js` – the automation engine and the on-page progress panel.
- `popup.html/css/js` – the options and progress UI.
- `test/` – mock YouTube pages and the test suite.
