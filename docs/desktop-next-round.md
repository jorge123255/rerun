# Next desktop port round — November 4, 2026

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
- C remains separate source work on `desktop/control-center-next`: three untracked Control Center source/test files were visible at the final review, with HEAD still `22a4052`. No completion, integration or validation is claimed for C.

Validation: 3,443 UI tests passed (20 skipped); all 3,030 engine tests passed; engine and UI type checks, production build, bundled-runtime verification and single-app installation passed. The full engine run also exposed two stale hosted catalog test assumptions about the Mac-only file-read grant; a test-only correction now verifies that boundary explicitly. Original B3 board attention had already passed its own release acceptance.

Native pending and completed snapshots matched after full restarts. Three disposable coworkers were removed only after a byte-verified recovery copy. Original coworkers retain exactly 23 chats and 88 messages. The synthetic local provider was stopped and its unused connection moved to the recovery folder; the Codex workspace default remained unchanged. Full parity groups D5, C7 and C8 stay open for their remaining slices in the checklist.
