# Next desktop port round — navigation, files and completed activity

Prepared base: `18b7e32fee452237ce1e7d5b79ea7cd5d0b18429`. The prior A/B/C/D ports are accepted below. Original Rerun reference remains `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

| Owner | Current slice | Prepared worktree / branch |
| --- | --- | --- |
| A | D5: original raster image previews for existing own files | `rerun-desktop-worktrees/file-image-previews` · `desktop/file-image-previews` |
| B | C8: actual opt-in card_file tool and original file-result cards for own text/Markdown | `rerun-desktop-worktrees/file-result-cards` · `desktop/file-result-cards` |
| C | B5: original built-in workspace illustration picker with local assets | `rerun-desktop-worktrees/workspace-icons` · `desktop/workspace-icons` |
| D | C7: original unread Done items from genuine terminal completions | `rerun-desktop-worktrees/completed-actions` · `desktop/completed-actions` |
| Integration owner | B5: durable Recent coworkers; all integration, testing and native acceptance | coding worktree `rerun-desktop` · `desktop/m1` |

All worktree paths are under `/Users/gszulc/OpenBot/Shared/`. These four worktrees are prepared at the base above, with prompts supplied to the user for dispatch; preparation does not imply external work has started. Only root runs tests, checks, builds, installation, live requests and native QA. No external lane changes the app installation, live workspace data or credentials, pushes or merges.

Root owns DesktopApp, DesktopBoard, DesktopConversation and central desktop database/bootstrap wiring. Lanes export typed callbacks/props and isolated schema initializers or migration definitions for root integration. A owns Files/image preview routes; B owns the card tool and assistant renderer; C owns the icon picker/assets/local icon API; D owns the completion receipt/inbox path. Keep the existing pending attention endpoint unchanged.

A follows FilePreview/FileDetail without adding model vision. B follows cards.ts/card_file and FileCard without inventing table cards; database-backed table views remain a prerequisite. C must vendor original illustration bytes: the upstream catalog URLs are hosted assets, not bundled resources. D must capture non-cancelled terminal done events rather than treating all run rows with status done as completions: original HITL turns also have that status. D starts at an explicit persisted activation cutoff, with no ambiguous historical backfill. Durable read state acknowledges only displayed completion identities.

Root is implementing the original five-item Recent order using the local database instead of origin-bound localStorage. The original rows and keyboard behavior remain. Full parity groups remain open until their other missing slices are accepted.

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

Both disposable coworkers were deleted through the board only after a byte-verified recovery copy. Final read-only checks confirmed their folders and desktop rows were gone, database foreign keys were clean, the original 23 chats and 88 messages were exactly unchanged, and the Codex default was preserved. B5 remains open: Recent coworkers are session-only, and richer contextual actions, open-tab/recent-chat lists, boxes and workspace-icon customization still need ports. See `docs/desktop-control-center.md` for the final contract.
