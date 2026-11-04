# Rerun Mac delivery checklist

Updated November 4, 2026. Installed source: `220eeff3b7889f8481dc3a705d877ad68aad4cba`.

The parity catalog now has **29 unfinished capability groups**, down from 30 because **B2 Boxes is complete**. This is a scope count, not the number of individual tasks left. Several groups contain working features and multiple missing features. Use the concrete tasks below for delivery updates; retain the catalog as the full scope reference. Do not remove unfinished work or close an area just to reduce the count.

## Current delivery — 1 of 9 tasks accepted

All eight lane worktrees were prepared from `927c5e17da6b6db84657261695a98e0533b264de`. Root owns integration and every check, build, installation, live model call and Mac/restart test.

**B, G and H have reviewed committed handoffs and are integrated into the coding branch, pending final root checks and Mac acceptance.** B: `c7db894fee5ae05553dde98006ec13e969bb9e57`; G: `925dead9ac7e30c41cd0f01bfb723f0b570cb69b`; H: `181d467cefcc2adfac0b5f6a40ce80bc3fd81e1a` and `406f35aac90e123021202741cecd790f101e9b6d`. Uncommitted alternate implementations remain excluded. Root has also reviewed A `6d2e177a9c6e4377935bf87479822873683c10c7`, E `7e67ce1907ede7e43acda346027835b1923a6a0b`, and F `7c69dd4e53ca0174b75be77553a2858109fcfacb`; these are not integrated or accepted. E needs the rest of its assigned schedule slice, and F needs lifecycle/credential corrections. The installed accepted build remains `220eeff`. Root alone runs all checks and Mac acceptance.

- [ ] **A — D5:** existing own PDF previews using the original Files frame.
- [ ] **B — C3:** multiple existing text attachments through drafts, queues, send and history.
- [ ] **C — C7:** local notifications/preferences and correct request age.
- [ ] **D — E6:** local Skills and exact proposal review.
- [ ] **E — E8:** schedules while Rerun is running, with durable chat adoption.
- [ ] **F — E5:** HTTPS Streamable HTTP MCP connections and real tools.
- [ ] **G — D7:** private/shared data tables and original views.
- [ ] **H — E2:** bounded public-page web_fetch.
- [x] **Root — B5:** original Control Center Box search/member drill, Move to another Box and New Box. Installed and accepted in `220eeff`; the full B5 group remains partial.

Root passed **3,909 UI tests (39 existing skips; 436 test files passed and 14 skipped)**, UI typecheck, packaging and runtime verification for installed source `220eeff3b7889f8481dc3a705d877ad68aad4cba`. Native Control Center Box search/member selection, first-open camera framing, correct source/destination membership counts, Move to another Box, and New Box Cancel/Save passed while preserving the selected chat and draft. A real Codex reply of **42** before restart and **43** afterward, plus exact saved-state comparison, passed full-restart acceptance. Engine source was unchanged; the earlier **3,080-test engine pass** remains the last engine run and was not rerun. After the verified recovery backup at `work/control-boxes-completed-recovery/verified-manifest.json`, root removed the disposable coworker through the authenticated app API and both empty QA Boxes through the original native Delete dialogs. A full quit/reopen then passed `work/control-boxes-clean-after-restart.log` and `work/control-boxes-original-final-after-restart.log`: original Box geometry/membership, workspace and provider defaults, identities and all **2 coworkers / 23 chats / 88 messages** were preserved exactly, with no fixtures remaining. The final native board showed only My workspace and the two original tiles, with Codex connected using `gpt-6.1-sol`. Evidence: [Control Center Boxes acceptance](desktop-control-center-boxes-acceptance.md).

See `desktop-next-round.md` for the exact worktrees, prompts and shared-file boundaries. These tasks do not add nine new scope groups. The catalog remains 29 until a whole group is completed.

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
| D5: Files | Text editing/conflicts; rename/Delete; static raster, WAV/MP3 and MP4 previews; previous/next navigation | PDF; additional media formats and animation |
| C8: Conversation activity and results | File steps; suggested replies; live compaction; text/static-image/audio/MP4 result cards | Child runs; tables; additional formats and request presentations |

These rows explain partial completion; they are not four new tasks added to the scope. The full parity catalog retains the original source references and connected-workspace decisions. C5 and C6 currently describe overlapping credential/service/sign-in/takeover work; they must not be counted as two independent tasks in the delivery ledger.
