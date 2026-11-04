# Rerun Mac delivery checklist

Updated November 4, 2026. Installed source: `414e325aad073f281aebfed273a785c410f54d03`; installed build ID: `414e325-desktop-0.1.0`.

The parity catalog now has **29 unfinished capability groups**, down from 30 because **B2 Boxes is complete**. This is a scope count, not the number of individual tasks left. Several groups contain working features and multiple missing features. Use the concrete tasks below for delivery updates; retain the catalog as the full scope reference. Do not remove unfinished work or close an area just to reduce the count.

## Current delivery — 3 of 3 tasks accepted

Evidence: [Boxes, media and navigation acceptance](desktop-boxes-media-navigation-acceptance.md).

- [x] **Root: B2, Boxes on the board — the complete capability group.** Original add controls, naming dialog, context menu and Delete confirmation are installed. Create and rename Boxes; move coworkers by drag or Move to Box; move/resize Boxes with their coworkers and retain their positions; refuse deletion while a Box contains coworkers; delete an empty Box after confirmation. Native board/chat checks and full-restart persistence passed in `414e325`, including native rechecks of rapid cross-Box tile interaction and whole-Box dragging. Pointer-cancel behavior passed the automated regression.
- [x] **A/C: D5, Previous file / Next file — one task.** The matching handoff `af0f050` was integrated once. Original arrows, position indicator, sibling ordering and wraparound preserve editing and media safeguards. Native Files checks and full-restart acceptance passed in `414e325`.
- [x] **B: C8, MP4 result cards in chat.** Handoff `d4693bd` plus root integration fixes supplies original video albums/mixed tiles and lightbox for actual coworker file results, with explicit playback, bounded lazy reads, URL cleanup and stale-file refusal. Native chat/media checks and full-restart acceptance passed in `414e325`.

Root passed **3,888 UI tests (39 existing skips)**, **3,080 engine tests**, type checks, packaging, installation and native feature/full-restart acceptance. After a verified full app-quit recovery backup, root removed only the two fixture coworkers and confirmed deletion of the two temporary Boxes. Checks before and after the final full quit/reopen preserved the exact original Box geometry/membership, workspace and provider defaults, and **23 chats / 88 messages**. Temporary owners, folders and Boxes were gone; foreign-key checks were clean. The final native board showed only My workspace and the two original coworkers, with Codex connected.

All three follow original Rerun at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. Only root runs checks, builds, installation, live-model calls and Mac/restart tests. Source completion alone does not check a task off. The identical A/C handoff counts once; D5 and C8 remain partial despite these completed slices.

## Previous delivery — 3 of 3 tasks accepted

- [x] **D: pending Actions read receipts.** Mark one request read or confirm Mark all; preserve the unanswered request and remember acknowledgments after restart. Accepted in `c6fa087`.
- [x] **Root: live collapsed Actions counts.** Keep pending and Done counts current while the inbox is closed; count actual completed runs. Accepted in `c6fa087`.
- [x] **C plus root integration: workspace logo upload.** Original upload preview, atomic name/logo Save, Cancel, replacement and restart persistence. Root fixed the packaged image-library failure and verified the Mac app. Accepted in `b85926c`.

Evidence: `desktop-pending-inbox-acceptance.md` and `desktop-workspace-logo-acceptance.md`. Both releases preserved the original 23 chats and 88 messages after backed-up cleanup and a final restart.

## Why the recent areas remain open

| Area | Accepted work | Remaining work |
| --- | --- | --- |
| B5: Control Center and workspace customization | Local commands; recent/open chats; Needs you; theme and shortcuts; original illustrations; local logo upload | Website logos; remaining Control Center Box navigation/contextual commands and unsupported coworker-panel commands as their features land. Board Boxes are complete under B2 |
| C7: Actions and notifications | Pending and Done inbox; exact navigation; persistent individual/bulk read; live closed counts | Pending-request age/order from the request's timestamp; notifications; per-coworker notification preferences |
| D5: Files | Text editing/conflicts; rename/Delete; static raster, WAV/MP3 and MP4 previews; previous/next navigation | PDF; additional media formats and animation |
| C8: Conversation activity and results | File steps; suggested replies; live compaction; text/static-image/audio/MP4 result cards | Child runs; tables; additional formats and request presentations |

These rows explain partial completion; they are not four new tasks added to the scope. The full parity catalog retains the original source references and connected-workspace decisions. C5 and C6 currently describe overlapping credential/service/sign-in/takeover work; they must not be counted as two independent tasks in the delivery ledger.
