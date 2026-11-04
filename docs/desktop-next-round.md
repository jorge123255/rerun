# Next desktop port round — audio, image cards, logos and own instructions

Prepared base: `49a224e75c2d6b76f441b24f41d813d2b382ee99`. Original Rerun reference: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

| Owner | New slice | Worktree / branch |
| --- | --- | --- |
| A | D5: existing own WAV/MP3 playback using original Files audio preview | `file-audio-previews` / `desktop/file-audio-previews` |
| B | C8: original static image albums and paged preview from actual card_file results | `file-image-cards` / `desktop/file-image-cards` |
| C | B5: original local logo upload in workspace settings, preserving atomic name/icon save | `workspace-logo-upload` / `desktop/workspace-logo-upload` |
| D | E7: opt-in own instruction/reply-length self tools and original Improve itself controls | `self-instruction-controls` / `desktop/self-instruction-controls` |
| Root | B5: original Control Center workspace settings, board recenter and durable theme commands; integration and all testing | coding worktree `rerun-desktop` / `desktop/m1` |

All four external worktrees are prepared under `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/` at the exact base above. Prior lane worktrees are preserved. Prompts are prepared for user dispatch; this does not assert that agents have started. Only root runs tests, lint/type checks, builds, packaging, installation, live model requests and native Mac QA. Lanes may author regressions but do not execute them, install dependencies, touch the installed app, credentials or live workspace, push or merge.

Ownership: A owns coworker Files/audio read and presentation; B owns card-specific engine validation and chat result rendering, reusing installed image reads without changing their limits; C owns workspace upload/picker/storage helpers and supplies typed root wiring notes; D owns own-instruction tools and narrow grant/config/Tools controls. Root retains DesktopApp, DesktopBoard, DesktopConversation, central bootstrap and the Control Center. B and C consume image-bytes.ts read-only. A preserves the accepted image reader and runtime path tracing annotations.

Scope remains bounded: A adds no recording or model audio input; B adds no image chat inputs, generated-file publication or table cards; C adds no website fetch, SVG/GIF animation or hosted storage; D adds no package installation, MCP registration, credential flow or arbitrary command permissions. All four follow the pinned original components rather than inventing replacements. Full D5/C8/B5/E7 parity stays open until the remaining capabilities pass integration and Mac acceptance.

Root’s slice is accepted in installed source `978cee1`: original Workspace settings, Recenter the board and durable Switch to light/dark theme commands. Root passed 3,629 UI tests (20 existing skips), typecheck, production packaging and runtime verification, then exercised the commands with a real Codex reply and draft in the Mac app. Theme, exact chat/tab/message/draft state and provider defaults survived restart. Original appearance was restored; cleanup after a verified recovery copy preserved all original 23 chats and 88 messages. Engine source was unchanged and its suite was not rerun. See `desktop-control-center-actions.md`. This acceptance does not change the prepared external-lane base or assert that those agents have started.

The preceding round is accepted in installed source `6fdf5f0`: A static raster previews, B text-file result cards, C 50 workspace illustrations and D genuine Done items. Root passed 3,620 UI tests (20 existing skips); the unchanged engine passed 3,063 tests in that round. Board/live Codex/restart acceptance preserved the original 23 chats and 88 messages exactly. See `desktop-files-done-acceptance.md` and `desktop-workspace-icons-acceptance.md`.

---

# Previous desktop port round — navigation, files and completed activity

Prepared base: `18b7e32fee452237ce1e7d5b79ea7cd5d0b18429`. The prior A/B/C/D ports are accepted below. Original Rerun reference remains `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

| Owner | Current slice | Prepared worktree / branch |
| --- | --- | --- |
| A | D5: original raster image previews for existing own files | `rerun-desktop-worktrees/file-image-previews` · `desktop/file-image-previews` |
| B | C8: actual opt-in card_file tool and original file-result cards for own text/Markdown | `rerun-desktop-worktrees/file-result-cards` · `desktop/file-result-cards` |
| C | B5: original built-in workspace illustration picker with local assets | `rerun-desktop-worktrees/workspace-icons` · `desktop/workspace-icons` |
| D | C7: original unread Done items from genuine terminal completions | `rerun-desktop-worktrees/completed-actions` · `desktop/completed-actions` |
| Integration owner | B5: durable Recent coworkers plus Open chats / Recent conversations; all integration, testing and native acceptance | coding worktree `rerun-desktop` · `desktop/m1` |

All worktree paths are under `/Users/gszulc/OpenBot/Shared/`. These four worktrees are prepared at the base above. The user confirmed dispatching their prompts; lane completion and acceptance are not implied. Only root runs tests, checks, builds, installation, live requests and native QA. No external lane changes the app installation, live workspace data or credentials, pushes or merges.

Root owns DesktopApp, DesktopBoard, DesktopConversation and central desktop database/bootstrap wiring. Lanes export typed callbacks/props and isolated schema initializers or migration definitions for root integration. A owns Files/image preview routes; B owns the card tool and assistant renderer; C owns the icon picker/assets/local icon API; D owns the completion receipt/inbox path. Keep the existing pending attention endpoint unchanged.

A follows FilePreview/FileDetail without adding model vision. B follows cards.ts/card_file and FileCard without inventing table cards; database-backed table views remain a prerequisite. C must vendor original illustration bytes: the upstream catalog URLs are hosted assets, not bundled resources. D must capture non-cancelled terminal done events rather than treating all run rows with status done as completions: original HITL turns also have that status. D starts at an explicit persisted activation cutoff, with no ambiguous historical backfill. Durable read state acknowledges only displayed completion identities.

Root implemented and installed the original five-item Recent order in `143bca3e1aff32890c38c07097867924766f9c3f`, using the local database instead of origin-bound localStorage. The original rows and keyboard behavior remain. Root passed 3,488 UI tests (20 skipped), typecheck, production build and bundled-runtime verification, then confirmed exact Recent ordering after a full Mac restart and correct saved-chat navigation back to the board. The original 23 chats and 88 messages are unchanged. Engine source was unchanged and its suite was not rerun. Full parity groups remain open until their other missing slices are accepted.

Root also installed Open chats and Recent conversations in `4e04914be8f1c7e41cd71ac36e4ec81f88b5d661`. The original Control Center view and coworker drill now navigate to exact persisted tabs, including blank drafts, and eight recent non-open saved chats ordered by actual engine activity. Root passed 3,518 UI tests (20 skipped), typecheck, build and runtime verification. Two real Codex replies, four drafts, same-title owner isolation, close/reopen and full restart navigation passed in the Mac app. Cleanup preserved all original 23 chats and 88 messages. External assignments and ownership above remain unchanged. See `docs/desktop-control-center.md` for the source contract and acceptance evidence.

---

# Previous round — accepted November 4, 2026

Source base for the four external lanes: `22a40524067ec8f36267a802e35ad5ca63dcad47`. This contains the accepted draft release plus the shared attention response schema. Original Rerun reference remains `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

| Owner | Slice | Worktree / branch |
| --- | --- | --- |
| A | D5: original Files Delete flow with confined paths and confirmation | `rerun-desktop-worktrees/file-delete-next` · `desktop/file-delete-next` |
| B | C8: original live context-compaction presentation; no invented history metrics | `rerun-desktop-worktrees/compaction-next` · `desktop/compaction-next` |
| C | B5: original Control Center for available local actions | `rerun-desktop-worktrees/control-center-next` · `desktop/control-center-next` |
| D | C7: original Actions inbox for pending questions and approvals | `rerun-desktop-worktrees/actions-inbox-next` · `desktop/actions-inbox-next` |
| Integration owner | B3: waiting-for-you board tile, exact pending-chat navigation and shared read-only attention projection | coding worktree `rerun-desktop` · `desktop/m1` |

All paths are under `/Users/gszulc/OpenBot/Shared/`. The four worktrees are prepared; prompts are supplied to the user for dispatch. That does not imply the external agents have started or completed their changes.

Only the integration owner runs tests, lint/type checks, builds, installation, live model requests and native app testing. C may resume coding; its prior stop on app/data manipulation remains in effect. No lane changes real workspace data or credentials, creates another app installation, pushes, or merges.

Root owns DesktopApp/DesktopBoard/global shortcut mounting this round. C and D export components and typed callbacks with integration notes rather than modifying the app shell independently. D consumes `lib/desktop/attention.ts` and GET `/api/desktop/attention`; root owns the authenticated read-only aggregation route. Opening an inbox item does not answer, accept, dismiss, execute or grant anything. Unknown or partial reads remain distinct from an empty list.

A follows original Files behavior, B reuses CompactionStep/CompactionBlock, C reuses ControlCenterView, D follows WorkspaceInbox and the shared inbox primitives, and root reuses the original waiting tile. The engine compaction checkpoint lacks persisted display counts, so B must state its live-only history limitation. Full parity groups remain open until all their remaining slices are installed and accepted.

## Integration status after root acceptance

A, B and D are integrated and installed from `7cf2bc3218b3821388f06dc1210dbd8fe6c9f1e9`. Their original worktrees are preserved. Only root ran tests, builds, installation and Mac QA.

- A submitted `3a3ce63`. Root corrected recovery after failed exclusive staging, nested moved-directory guards and empty-directory replacement, and corrected the race fixture so its hook actually fires. Native Cancel, file/folder Delete, symlink refusal, old attachment/draft behavior and restart passed.
- B submitted `574d5a0` plus `b1eaf2d`. Root preserved the live-only history limit and fixed a native duplicate compaction row: desktop history preparation now emits a stable run identity before compaction; the provider cannot start a second assistant message. Actual SDK regression, replay/early-error/hosted behavior, and native success/error/Stop passed. Native compaction used synthetic histories with a local provider; real Codex chat still replied 13 afterward.
- D submitted `7251873` plus `961a1f4`. Root mounted the inbox on the board, guarded roster/scope/item identity, and kept unknown/partial reads and focus behavior correct. Real Codex question and approval navigation, pending restart, Blue answer, decline reason, draft isolation and resolved restart passed.
- C submitted `ace1be7`; its original Control Center view is integrated and installed in the later build `b0d8c01`. Root mounted it through the workspace menu and keyboard, added scope-before-cap search, guarded stale results/navigation, preserved existing chat/editor shortcuts and fixed focus return after Radix cleanup. Native coworker/search/command navigation and restart passed. The source worktree remains preserved.

Validation: 3,443 UI tests passed (20 skipped); all 3,030 engine tests passed; engine and UI type checks, production build, bundled-runtime verification and single-app installation passed. The full engine run also exposed two stale hosted catalog test assumptions about the Mac-only file-read grant; a test-only correction now verifies that boundary explicitly. Original B3 board attention had already passed its own release acceptance.

Native pending and completed snapshots matched after full restarts. Three disposable coworkers were removed only after a byte-verified recovery copy. Original coworkers retain exactly 23 chats and 88 messages. The synthetic local provider was stopped and its unused connection moved to the recovery folder; the Codex workspace default remained unchanged. Full parity groups D5, C7 and C8 stay open for their remaining slices in the checklist.

### Latest C release acceptance

Installed build: `b0d8c012118b5c99489a6a4c2aae071081d2a28f`. Root passed 3,468 UI tests (20 skipped), UI typecheck, production build, bundled-runtime verification and the single-app install. Focused search, adapter and real-App integration cases are included in that total. Engine source was unchanged; the preceding 3,030-pass engine result above is prior release evidence, not a rerun for C.

Native checks used two disposable coworkers with 55 saved fixture chats. A coworker-scoped search found its older chat despite 52 newer sibling matches; the unscoped search displayed its 50-result refinement hint. Real Codex replies were 108 and 210. Workspace-menu and keyboard entry, the three available commands, board/chat navigation, focus return, editor Find and discard, Settings, creation and duplicate-placement guards passed. Full quit/reopen restored the replies, all three text drafts and the selected attachment; exact saved-state snapshots matched across restart.

Both disposable coworkers were deleted through the board only after a byte-verified recovery copy. Final read-only checks confirmed their folders and desktop rows were gone, database foreign keys were clean, the original 23 chats and 88 messages were exactly unchanged, and the Codex default was preserved. At this earlier release Recent coworkers were session-only. The later 143bca3 follow-up above makes them durable; richer contextual actions, open-tab/recent-chat lists, boxes and workspace-icon customization still need ports. See `docs/desktop-control-center.md` for the final contract.
