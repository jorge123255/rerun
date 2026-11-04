# Rerun Mac delivery checklist

Updated November 4, 2026. Installed build: `b85926c`.

The parity catalog's **30** is the number of unfinished capability areas, not the number of individual tasks left. Several areas contain working features and multiple missing features. That number did not show the last delivery's progress. Use the concrete tasks below for delivery updates; retain the catalog as the full scope reference. Do not remove unfinished work or close an area just to reduce the count.

## Last delivery — 3 of 3 tasks accepted

- [x] **D: pending Actions read receipts.** Mark one request read or confirm Mark all; preserve the unanswered request and remember acknowledgments after restart. Accepted in `c6fa087`.
- [x] **Root: live collapsed Actions counts.** Keep pending and Done counts current while the inbox is closed; count actual completed runs. Accepted in `c6fa087`.
- [x] **C plus root integration: workspace logo upload.** Original upload preview, atomic name/logo Save, Cancel, replacement and restart persistence. Root fixed the packaged image-library failure and verified the Mac app. Accepted in `b85926c`.

Evidence: `desktop-pending-inbox-acceptance.md` and `desktop-workspace-logo-acceptance.md`. Both releases preserved the original 23 chats and 88 messages after backed-up cleanup and a final restart.

## Next delivery — 0 of 3 tasks accepted

- [ ] **Root: B2, Boxes on the board — the complete capability area.** Follow the original Box add controls, naming dialog, context menu and Delete confirmation. Create and rename Boxes; move coworkers by drag or Move to Box; move/resize Boxes with their coworkers and retain their positions; refuse deletion while a Box contains coworkers; delete an empty Box after confirmation. Verify board → coworker chat → close, preserved chats/files/settings and exact membership/layout after restart. Root owns the local schema/API, board and app integration, all tests, packaging and native acceptance. Assigned next; implementation is not yet accepted.
- [ ] **A: D5, Previous file / Next file.** Original arrows, position indicator, sibling ordering and wraparound, with editing and media safeguards. Prompt/worktree prepared; acceptance pending.
- [ ] **B: C8, MP4 result cards in chat.** Original video album/mixed tiles and lightbox for actual coworker file results, with explicit playback and stale-file refusal. Prompt/worktree prepared; acceptance pending.

All three follow original Rerun at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. Only root runs checks, builds, installation, live-model calls and Mac/restart tests. Source completion alone does not check a task off.

When B2 passes all of its acceptance checks, the unfinished capability-area count becomes **29**. A's and B's individual tasks will be checked off independently; their broader Files and result-card areas may still have remaining work.

## Why the recent areas remain open

| Area | Accepted work | Remaining work |
| --- | --- | --- |
| B5: Control Center and workspace customization | Local commands; recent/open chats; Needs you; theme and shortcuts; original illustrations; local logo upload | Website logos; Box/contextual commands and unsupported coworker-panel commands as their features land |
| C7: Actions and notifications | Pending and Done inbox; exact navigation; persistent individual/bulk read; live closed counts | Pending-request age/order from the request's timestamp; notifications; per-coworker notification preferences |
| D5: Files | Text editing/conflicts; rename/Delete; static raster, WAV/MP3 and MP4 previews | A's previous/next navigation; PDF; additional media formats and animation |
| C8: Conversation activity and results | File steps; suggested replies; live compaction; text/static-image/audio result cards | B's MP4 cards; child runs; tables; additional formats and request presentations |

These rows explain partial completion; they are not four new tasks added to the scope. The full parity catalog retains the original source references and connected-workspace decisions. C5 and C6 currently describe overlapping credential/service/sign-in/takeover work; they must not be counted as two independent tasks in the delivery ledger.
