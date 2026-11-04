# Boxes, Files navigation and MP4 cards — accepted

Root accepted all three delivery tasks in the installed Mac app on November 4, 2026: complete **B2 Boxes**, **D5 Files previous/next**, and **C8 MP4 result cards**. Backup, disposable-state cleanup and the final original-workspace restart also passed. This closes B2 and leaves **29 unfinished capability areas**; D5 and C8 remain partial for their other features.

## Source and installed artifact

- Final source/build: `414e325aad073f281aebfed273a785c410f54d03`, branch `desktop/m1`.
- Runtime manifest build ID: `414e325-desktop-0.1.0`; root verified its `sourceCommit` matches the final source above.
- Coding worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop`.
- Build worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/codex-login-build`.
- Canonical installed app: `/Users/gszulc/Applications/Rerun Desktop Preview.app`.
- Architecture: arm64. Production packaging and runtime verification passed, including native libsql and Sharp dependencies.
- Original Rerun reference: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

Boxes landed in `cdbde55` with fixture corrections in `542d155`; MP4 cards in `61ba1f2` with review corrections in `17499a9`; Files navigation in `5797768` with shortcut/editor corrections in `954b8bb`, `7ddb302` and `18aed54`. Fixture updates followed in `2456b1a`. Native drag QA produced the real-IsoGrid regression `5069828` and bounded fix `414e325`.

**A/C deduplication:** A and C reported the same Files-navigation handoff, `af0f050223f55570928327dfb44255f1e1a9bdf3`, integrated once as `5797768`. It counts as one delivered task. C's previously accepted workspace-logo work remains a separate historical delivery.

## Original behavior preserved

**Boxes:** original New Box form, side-add controls, context menus, rename and typed Delete confirmation; radial/adjacent placement; coworker drag and Move to Box; whole-Box movement and resize. Coordinates remain absolute and inclusive, coworkers occupy two-by-two cells, minimum Box span is four cells, and neighboring Boxes retain a one-cell gap. Box movement translates its members; resize retains their absolute positions and cannot exclude them. Populated Boxes cannot be deleted.

Migration preserves the old synthetic board's positions and duplicate receipts in durable Box/membership tables without changing coworker IDs, engine configuration, chats, files or settings. Transactions cover layout/revision changes and retry receipts; receipt replay returns the current board without reapplying the operation. Bootstrap reads roster and board from one snapshot. Pending copies reserve their cells; destination Box movement/resize/deletion is blocked until resolved, and publication checks occupancy again. Creation checks the selected Box before creating the engine coworker.

These behaviors follow original `box.service.ts`, `board.store.ts`, `space-layout.ts`, `agent.service.ts`, `IsoBoard.tsx`, `BoardContextMenu.tsx`, `ClaimSpaceDialog`/`NewBoxForm`, `RenameBoxDialog` and `DeleteSpaceDialog`.

**Files navigation:** original sibling ordering, previous/next controls, index, wraparound and current-folder scope. Navigation skips directories and respects hidden-file filtering, editing/save/conflict/confirmation state, typing, overlays and native media seeking. Back retains the folder. Review fixes preserve unsaved edits against late listing refreshes and retain accepted preview bytes when closing an unchanged editor. Mac shortcut help includes the Files keys. This follows `useSiblingFiles.ts`, `sort-file-entries.ts`, `FileDetail.tsx` and `AgentPanelFiles.tsx`.

**MP4 cards:** the opt-in `card_file` tool presents existing coworker-owned MP4 files using original media albums, mixed tiles and a paged lightbox. Playback requires user action. The adapter retains owner/path/inode checks, a 16 MiB per-video bound and a combined 24 MiB image/video budget. Visible albums load at most four previews; hidden media loads on selection. Review fixes release failed previews and stop/detach players across lifecycle changes. The design follows original `cards.ts`, `chat-card.ts`, `FileCard`, `MediaAlbum`, `ChatVideoTile`, `AttachmentTile`, `AttachmentLightbox` and `FilePreview`.

## Automated checks run by root

| Check | Accepted result |
| --- | --- |
| Final UI suite | **3,888 passed; 39 existing skipped**, across **434 passing files; 14 skipped files** |
| Final UI typecheck | **Passed** |
| Engine suite and typecheck | **3,080 passed; typecheck passed**. Root confirmed engine/contracts source is unchanged from `17499a9` through `414e325`; no later rerun is implied. |
| Real-IsoGrid drag negative control at `5069828` | **5 failed, 1 passed**, reproducing the native defect |
| Focused checks after `414e325` | **27 passed across 4 files**, including 6 new tests |
| arm64 packaging, runtime verification and installation | **Passed** |

The focused cases overlap the full suite and are not added to its total. Skips are not passes. Automated coverage includes real-IsoGrid pointer cancellation, migration and exact placements, CRUD/geometry/capacity, revision conflicts and idempotent retries, bootstrap interleaving, creation/deletion/copy reservations, authentication and bounded input, media admission/budgets/identity/lifecycle, editor/navigation guards and app integration. Pointer-cancel coverage is automated; the native drag evidence below is fast cross-Box movement and whole-Box movement, not a native pointer-cancel claim.

## Native Mac evidence

### First candidate: `2456b1a`

- Migration retained the two original coworker positions `(3,3)` and `(6,3)`. Original dialogs created two QA Boxes; Cancel made no change. QA coworkers were created through empty-Box invitations.
- From board-side chats, GPT-6.1 Sol returned “Video board check 73.” with a six-MP4 card, “Mixed board check 73.” with text/image/audio/video, and “Sibling board check 19.” The chats retained distinct unsent drafts.
- Inline MP4 playback worked; starting another video paused the first. The hidden `5 / 6` lightbox item played, paging reached the next item, and closing worked. The mixed card played video and then opened audio.
- Files navigated notes `8 / 9` → audio `9 / 9` → video `1 / 9`. Right on native audio/video scrubbers sought without changing files; Left outside the player navigated. Editing hid navigation, and Keep editing in the discard confirmation retained the draft. No file edits were saved.
- A full restart passed the exact board/owner comparison. Both chats, drafts and cards reopened; Files Previous reached image `7 / 9`.
- Rename Cancel/Save, populated-Box Delete refusal, and menu-based Move to Box worked while exact content was preserved. Side-add created empty `Side Box QA`; a wrong typed name was blocked, Cancel retained it, and the correct name deleted only that empty Box.
- Review resized from `[1,7,8,14]` to `[1,7,10,16]`, revision `10 → 11`, preserving members. Rectangles here are `[col_start,row_start,col_end,row_end]`.

**Failure found:** native cross-Box dragging displayed a ghost without saving. That candidate was not accepted as the finished Boxes implementation. Root reproduced the defect with the actual IsoGrid and applied `414e325` before final native acceptance.

### Fixed installed build: `414e325`

- One fast primary-coworker drag from Project to Review saved immediately without additional UI input: revision `11 → 12`, anchor `(6,10)`.
- Whole-Box dragging moved Review from `[1,7,10,16]` to `[1,10,10,19]`, revision `12 → 13`. Both members shifted exactly three rows: primary `(6,13)`, sibling `(1,10)`. Other Boxes were unchanged.
- The `before-box-changes` content comparison passed. After fully quitting and reopening, the `final-layout` comparison matched the exact saved state. Opening both coworkers from the board retained their replies and distinct drafts.
- Primary notes at `8 / 9` showed the correct bytes; Next opened tone at `9 / 9`.
- Root replaced only primary `clip-1.mp4` with identical bytes but a new inode. The saved card explicitly reported renamed or replaced; Next opened `clip-2.mp4`, which played. This verifies stale identity refusal without blocking valid neighboring media.

These observations establish the fixed drag, whole-Box translation, content preservation, restart persistence and media behavior. Native resource-revocation counts, hidden network-request counts, malformed/unsupported-codec cases and zero-Box recovery are not inferred from screenshots; their relevant source cases remain automated evidence. No persisted Files-preview index is claimed.

## Backup, cleanup and final original-workspace restart

With the app quit, root created and verified the recovery backup recorded in `boxes-video-completed-recovery/verified-manifest.json`. Cleanup removed only the two QA owners through the coworker API, then deleted their two empty Boxes through the UI's typed-name confirmation.

The cleanup helper passed before and after the final full restart: original Box geometry/membership, workspace state and provider defaults matched exactly; foreign keys were clean and temporary folders were gone. The original checker confirmed exact identities and message contents for **23 chats / 88 messages**:

- **Settings QA:** 21 chats / 64 messages.
- **Codex connection check:** 2 chats / 24 messages.

The final native board showed only **My workspace** and its two original coworkers, with **Codex connected**. No unresolved feature defect remains from this delivery.

## Evidence

Evidence is task-local under `/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/work/`:

- UI: [full suite](/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/work/boxes-video-ui-full-final.log), [typecheck](/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/work/boxes-video-ui-types-final.log).
- Engine: [full suite](/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/work/boxes-video-engine-full.log), [typecheck](/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/work/boxes-video-engine-types.log).
- Drag defect/fix: [negative control](/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/work/boxes-drag-negative.log), [focused fixed checks](/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/work/boxes-drag-fixed.log).
- [Final build/install](/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/work/boxes-video-install-final.log).
- Layout snapshots: [before whole-Box movement](/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/work/boxes-video-before-whole-box-move.json), [after movement](/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/work/boxes-video-after-whole-box-move.json), [final layout](/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/work/boxes-video-final-layout.json).
- [Verified recovery manifest](/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/work/boxes-video-completed-recovery/verified-manifest.json), [original-state check after final restart](/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/work/boxes-original-final-after-restart.log).

## Remaining scope

This delivery does not add PDF rendering, shared-workspace media, additional video/audio/image formats or animation, recording/transcription/model video input, publication, or a saved preview index. C8 still lacks child runs, tables and other tool/request presentations. Those remain checklist work; they do not invalidate the accepted Boxes, sibling-navigation and existing-MP4-card scope.

Only root ran checks, built/installed the app, exercised live models and performed native/restart/cleanup acceptance. The contributing lanes authored source and regressions without running acceptance themselves.
