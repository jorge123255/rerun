# Desktop Control Center

Installed in Mac build `143bca3` on November 4, 2026, including durable Recent coworkers. The initial panel port was installed in `b0d8c01`. C submitted `ace1be7605eefcda3191918af493f81b62dd20b9`; root integrated it as `7e6417e` and completed the app integration and fixes in `b0d8c01`. Only root executed checks, builds, installation and native QA. The external source worktree is preserved.

## Original design and supported actions

The adapter reuses Rerun's `ControlCenterView`, types, query parser, rows, avatars, keyboard selection, Tab/right-arrow drill, Backspace return, loading and empty states. It is centered with `anchorToOrb={false}` because the Mac has no Foreman orb. Optional description, close hint, results hint and focus callback props preserve the hosted view's defaults while giving the Mac accurate copy and focus handling.

Original reference: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`, principally `apps/ui/components/control-center/ControlCenter.tsx`, `ControlCenterView.tsx`, `types.ts`, `useConversationSearch.ts`, and `apps/ui/lib/control-center/commands.ts` and `search.ts`.

The installed commands are **Add coworker**, **Team board** and **Model settings**. Team board closes the panel without recentering; Model settings opens the existing AI provider settings. `@` limits results to coworkers; `/` limits them to commands. Ordinary text searches saved conversation titles. Enter on a coworker opens its chat; Tab or right arrow drills into that coworker's conversation search. Selecting a saved conversation opens that exact local conversation through the same handler as Find chat. The board stays mounted and existing tab and draft persistence is reused. Disabled coworkers' history remains reachable without enabling them or sending a message.

## App integration and keyboard behavior

`DesktopApp` mounts one controlled `DesktopControlCenter`. The workspace menu opens it and preserves the intended focus return target. Current roster membership is checked again before opening a coworker or conversation. The adapter is disabled while Settings, coworker creation, a busy app operation, duplicate placement or quitting is active.

- **Command-F** opens or closes the center; modified Shift/Alt combinations and Mac Control-F are preserved.
- **Command-K** opens it from the board, while the existing open-chat shortcut still creates a new chat. It does not take over editing fields.
- A closed center does not open over another dialog or alert dialog, including Files, the original code editor or its discard confirmation. The editor retains its own Find shortcut.
- Escape returns focus after Radix has removed the focus scope. Reopening the center, a newer overlay, a disconnected/inert target, quitting or focus moved elsewhere prevents stale restoration. Navigation actions intentionally do not restore the old target.
- The existing quit bridge flushes drafts while the center closes and blocks new navigation. Cancelling quit restores the existing draft lifecycle.

## Search and stale navigation

The authenticated local conversation-title search accepts an optional `agentId`. It resolves that local coworker and applies the owner condition before the 50-result cap. An older matching chat cannot disappear from coworker search just because another coworker has 50 newer matches. Invalid scope returns 400; unknown, foreign or deleted scope returns 404 without falling back to workspace search. Unscoped Find chat keeps its existing behavior.

Search matches title substrings, accepts 2–200 characters and orders by newest creation. It does not search message bodies, files, memories or unsent drafts. The hook keys reads by query, scope, open cycle and retry. Closing and reopening even the same query requires a fresh result. Removed coworkers are filtered, and retained callbacks revalidate the current open cycle, page, query, result ID, owner, roster and quit/disabled state before navigation. Loading, empty and unavailable results remain distinct; unavailable results offer Retry. Capped results display a refinement hint.

## Persistence and remaining parity

Saved chats, replies, selected tabs, ordinary text drafts and selected attachments continue to use the existing Mac database. The Control Center adds no alternate chat identity or draft store.

The Recent coworker list now persists in the Mac database: at most five unique coworkers, most recent first, restored at bootstrap across app restarts and changed loopback ports. It follows original Rerun's `stores/control-center.store.ts` and `pushRecentAgent` behavior while replacing origin-bound localStorage. Restoring the list does not create a visit. New selections use an ordered writer, and pending selections stay visible over delayed acknowledgments.

The authenticated `/api/desktop/recent-coworkers` GET is read-only. POST accepts a local coworker ID, comparison revision and request UUID. The list and revision are read in one snapshot; writes, ordering and five-item pruning share one transaction. The last accepted request can be retried without duplicating it. A superseded request receives the newer snapshot and is discarded rather than promoted above a later visit. Foreign and deleted owners cannot be recorded. Temporary deletion remains retryable, and a refused deletion does not remove its old recent entry. Confirmed deletion cascades the entry away.

A failed save keeps the session list and offers Try again in the original panel. Quit freezes ordinary drafts immediately while allowing up to 1.5 seconds for Recent writes to settle alongside the existing draft handshake. Recent remains best-effort during a service failure and never replaces the draft-save protection. Richer contextual commands, open-tab/recent-chat lists, boxes and workspace-icon customization remain under B5; the full group is still incomplete.

## Root acceptance of the initial panel port

- Full UI suite: **3,468 passed, 20 skipped** across 396 passing files and 13 skipped files. UI typecheck, production build, bundled-runtime verification and single-app installation passed. The engine was unchanged in this slice; its prior 3,030-pass release suite was not rerun.
- Focused coverage includes 11 authenticated search-route cases, 16 adapter cases and 4 tests mounting the actual DesktopApp with its board, workspace menu, Settings, Files editor and confirmation dialogs. These overlap the full-suite count.
- Root's initial run caught the focus-return defect, which was fixed before packaging. Two integration fixture mistakes were corrected to use the original lowercase query normalization and `/` command prefix.
- Native QA opened coworkers and exact saved chats through the original panel, verified scoped search against 52 newer sibling matches, and checked the global 50-result hint. Signed-in Codex returned **108** and **210** in separate coworkers.
- All three commands, board visibility, chat Command-K, focus return, editor Find, discard confirmation, Settings, creation and duplicate-placement guards passed in the installed app.
- Full quit/reopen preserved both Codex replies, three independent drafts and the selected file. Both workspace files retained their original bytes after discarding the disposable editor change.
- A byte-verified recovery copy was made before deleting the two disposable coworkers through the board. Final verification found their folders, chats, tabs and drafts removed; foreign keys were clean. Original coworkers retained exactly **23 chats and 88 messages**, including exact message contents. The Codex default was unchanged and the app was left open on the board.

## Durable Recent acceptance

Installed source: `143bca3e1aff32890c38c07097867924766f9c3f`. Root passed the final full UI suite: **3,488 tests, 20 skipped**, across 398 passing files and 13 skipped files. UI typecheck, production build, bundled-runtime verification and single-app installation passed. Coverage includes lost acknowledgments, stale conflicts, rapid selections, maximum-five ordering, owner/deletion boundaries, retry, shutdown and bootstrap restoration. The engine was unchanged and its suite was not rerun.

Native Mac QA visited Settings QA, then Codex connection check; Recent showed that order reversed by recency. Selecting Settings QA from Recent moved it first and opened its existing chat. After a full Quit/reopen, the saved list and revision matched exactly, despite a changed loopback port. Opening the center alone did not record another visit. Selecting the restored Codex row opened its saved replies, and Close panel returned focus to its tile on the same board. No new model request was needed for this navigation-only change. Original identities and all **23 chats / 88 messages** remained exactly unchanged; foreign keys were clean. The app was left connected and open on the board.
