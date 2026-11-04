# Rerun Mac delivery checklist

Updated November 4, 2026. Installed source: `c41e83743cb969fc9814a2c64850d04cd762777f`.

The parity catalog has **28 unfinished capability groups**, down from 29 because **D7 private/shared data tables is complete**. Individual delivery tasks can complete part of a broader group; partial scope remains listed rather than being removed to reduce the count.

## Current delivery — 5 of 9 tasks accepted

All eight lane worktrees were prepared from `927c5e17da6b6db84657261695a98e0533b264de`. Root owns integration and every check, build, installation, live model call and Mac/restart test.

**A, B, G and H are installed and accepted in `c41e837`, alongside root’s previously accepted Control Center Box work: 5 of 9 delivery tasks are accepted.** A’s blank iframe was replaced by root’s bundled macOS PDF page renderer after native failure; the original Files header, frame and sibling navigation remain. B supplies multiple existing text attachments; G supplies private/shared tables and original views; H supplies bounded public-page fetching. Root also corrected saved-view route identity, stale Board previews and selected-view persistence across changing local app origins. C is still working and its uncommitted work is untouched. D `a34f5ce`, E `267c832` and F `0df850c` remain outside acceptance and need the reviewed corrections/root integration. Uncommitted alternatives remain excluded. Root alone ran all checks, builds, installation and Mac acceptance.

- [x] **A — D5:** existing own PDF previews in the original Files frame, with root’s working macOS renderer.
- [x] **B — C3:** multiple existing text attachments through drafts, queues, send and history. Native queued transition remains unobserved; queue/receipt regressions passed.
- [ ] **C — C7:** local notifications/preferences and correct request age. Still working.
- [ ] **D — E6:** local Skills and exact proposal review. Source corrections and root integration remain.
- [ ] **E — E8:** schedules while Rerun is running, with durable chat adoption. Remaining receipt replay correction and root activation wiring.
- [ ] **F — E5:** HTTPS Streamable HTTP MCP connections and real tools. Remaining list/admission corrections and root integration.
- [x] **G — D7:** private/shared data tables and original views; complete D7 scope.
- [x] **H — E2:** bounded public-page web_fetch; broader writeback/search scope remains.
- [x] **Root — B5:** original Control Center Box search/member drill, Move to another Box and New Box. Accepted previously in `220eeff`; full B5 remains partial.

Root passed **4,038 UI tests (39 existing skips; 449 test files passed and 14 skipped)**, UI typecheck, **16 shell tests**, **12 PDF helper/layout/provenance tests** and **9 installer/native-library tests**, plus production packaging and runtime verification. The **3,208-test engine pass** and engine typecheck apply to the unchanged final engine tree `e17381e565ecf69e2eed79df010a64afcfdd01a9`; PDF and view-preference follow-ups did not change that tree. Native PDF pages, zoom, errors and restart; multi-file chat/draft/history; private/shared data, editing/views/export; and public fetch passed. Final post-restart Codex replies returned **43 / 42 / HTTP 200** and **LANTERN, RIVER — 42**. Exact saved-state comparison passed after restart, including selected private Board and shared All rows views. After a verified full-quit recovery copy, root removed only the two disposable coworkers, QA shared table, their view preferences and identical QA exports. Another full quit/reopen preserved the original Box geometry, workspace/provider defaults and **2 coworkers / 23 chats / 88 messages** exactly. See [PDF, attachments, data and web acceptance](desktop-pdf-attachments-data-web-acceptance.md).

See `desktop-next-round.md` for worktrees, handoffs and correction prompts. D5, C3 and E2 retain their broader missing scope; completing these slices does not close those groups.

## Previous delivery — 3 of 3 tasks accepted

Evidence: [Boxes, media and navigation acceptance](desktop-boxes-media-navigation-acceptance.md).

- [x] **Root: B2, Boxes on the board — the complete capability group.** Original add controls, naming dialog, context menu and Delete confirmation are installed. Create and rename Boxes; move coworkers by drag or Move to Box; move/resize Boxes with their coworkers and retain their positions; refuse deletion while a Box contains coworkers; delete an empty Box after confirmation. Native board/chat checks and full-restart persistence passed in `414e325`, including native rechecks of rapid cross-Box tile interaction and whole-Box dragging. Pointer-cancel behavior passed the automated regression.
- [x] **A/C: D5, Previous file / Next file — one task.** The matching handoff `af0f050` was integrated once. Original arrows, position indicator, sibling ordering and wraparound preserve editing and media safeguards. Native Files checks and full-restart acceptance passed in `414e325`.
- [x] **B: C8, MP4 result cards in chat.** Handoff `d4693bd` plus root integration fixes supplies original video albums/mixed tiles and lightbox for actual coworker file results, with explicit playback, bounded lazy reads, URL cleanup and stale-file refusal. Native chat/media checks and full-restart acceptance passed in `414e325`.

Root passed **3,888 UI tests (39 existing skips)**, **3,080 engine tests**, type checks, packaging, installation and native feature/full-restart acceptance. After a verified full app-quit recovery backup, root removed only the two fixture coworkers and confirmed deletion of the two temporary Boxes. Checks before and after the final full quit/reopen preserved the exact original Box geometry/membership, workspace and provider defaults, and **23 chats / 88 messages**. Temporary owners, folders and Boxes were gone; foreign-key checks were clean. The final native board showed only My workspace and the two original coworkers, with Codex connected.

All three follow original Rerun at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. Only root runs checks, builds, installation, live-model calls and Mac/restart tests. Source completion alone does not check a task off. The identical A/C handoff counts once; D5 and C8 remain partial despite these completed slices.

## Earlier delivery — 3 of 3 tasks accepted

- [x] **D: pending Actions read receipts.** Mark one request read or confirm Mark all; preserve the unanswered request and remember acknowledgments after restart. Accepted in `c6fa087`.
- [x] **Root: live collapsed Actions counts.** Keep pending and Done counts current while the inbox is closed; count actual completed runs. Accepted in `c6fa087`.
- [x] **C plus root integration: workspace logo upload.** Original upload preview, atomic name/logo Save, Cancel, replacement and restart persistence. Root fixed the packaged image-library failure and verified the Mac app. Accepted in `b85926c`.

Evidence: `desktop-pending-inbox-acceptance.md` and `desktop-workspace-logo-acceptance.md`. Both releases preserved the original 23 chats and 88 messages after backed-up cleanup and a final restart.

## Why the recent areas remain open

| Area | Accepted work | Remaining work |
| --- | --- | --- |
| B5: Control Center and workspace customization | Local commands; recent/open chats; Needs you; theme and shortcuts; original illustrations; local logo upload; Box search/member drill, Move to another Box and New Box | Website logos; remaining contextual actions and unsupported coworker-panel commands as their features land. Board Boxes are complete under B2 |
| C7: Actions and notifications | Pending and Done inbox; exact navigation; persistent individual/bulk read; live closed counts | Pending-request age/order from the request's timestamp; notifications; per-coworker notification preferences |
| D5: Files | Text editing/conflicts; rename/Delete; static raster, WAV/MP3/MP4 and PDF previews; previous/next navigation | Additional media formats and animation; remaining PDF interactions |
| C8: Conversation activity and results | File steps; suggested replies; live compaction; text/static-image/audio/MP4 result cards | Child runs; tables; additional formats and request presentations |

These rows explain partial completion; they are not four new tasks added to the scope. The full parity catalog retains the original source references and connected-workspace decisions. C5 and C6 currently describe overlapping credential/service/sign-in/takeover work; they must not be counted as two independent tasks in the delivery ledger.
