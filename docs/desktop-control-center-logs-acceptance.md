# Control Center Logs — Mac acceptance

Accepted November 4, 2026 by root. Installed source: `86c35a307831da45c5f844bd81995181755f6bfe`. Running build: `86c35a3-desktop-0.1.0`. One installed app: `/Users/gszulc/Applications/Rerun Desktop Preview.app`.

## What changed

The coworker's original Control Center **Open → Logs** row now opens the installed Recent runs dialog. It reuses Rerun's `LOGS_TAB` label, icon, description and ordering, rather than adding a separate command or run store. Original reference: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`, `apps/ui/components/agent/agent-tabs.ts`, `apps/ui/components/control-center/ControlCenter.tsx`, and `apps/ui/components/agent/AgentPanelLogs.tsx`.

The selected chat owns dialog state through the existing guarded panel request. The existing coworker card's Runs button still opens/closes the same controlled dialog. The board and chat stay mounted; closing and Back to the chat return to the selected reply and draft. Existing owner-keyed reads, refresh, cancellation and retry behavior are retained. No engine, contract, schema, authentication or network policy changed.

## Root checks

- Full UI: **4,039 passed, 39 existing skips**; 449 test files passed, 14 skipped. `work/control-logs-ui.log`.
- UI typecheck passed. `work/control-logs-types.log`.
- Production compilation, bundled-runtime verification, packaging, canonical installation and installed/running build identity passed. `work/control-logs-install.log`, `work/control-logs-runtime-provenance.log`.
- The prior **3,208-test engine pass** applies to the unchanged engine tree `e17381e565ecf69e2eed79df010a64afcfdd01a9`; contracts remain `55e5f740eac146fc1e54e072dfe0d08c51b41cc2`. Those tests were not redundantly rerun for this UI-only change.

The full UI pass includes real App/board/Control Center integration: original row metadata/order; owner-scoped saved runs; selected second tab; two independent drafts and replies across remount; controlled owner-change abort with ignored late response; and existing empty/error/retry/refresh/close tests. Native unavailable-server failure was not induced; that boundary is covered by automated tests.

## Native Mac and restart evidence

All UI actions used Computer Use on the installed Mac app. Root created only disposable **Logs Navigation QA** and **Logs Empty QA** from the board.

1. Sent a live Codex message from the board side panel. It returned **42** using `gpt-6.1-sol`.
2. Typed an unsent draft, opened Command-F → coworker → Tab → Logs, and observed the correct completed run, model, usage and Step 1 details.
3. Done returned to the same selected chat/draft. The existing Runs button reopened the dialog; Escape closed it. Back to the chat restored ordinary chat controls.
4. Created a second tab with a different unsent draft, opened Logs from it, and verified one dialog and the selected second tab's draft remained intact.
5. The second coworker showed **No runs yet for this coworker**, without leaking the first coworker's run.
6. Fully quit, verified runtime shutdown, reopened the installed app, and compared exact persisted board layout, settings/grants, sessions/messages, tabs, both drafts and recorded runs. All matched. `work/control-logs-after-restart.log`.
7. Reopened the coworker from the restarted board: the second tab/draft remained selected. Control Center Logs showed the same persisted run and details. Switched to the first tab and saw its **42** reply and different draft.
8. Sent a fresh post-restart turn; Codex returned **43**, and Logs showed its second completed run. The first draft was restored. Empty-owner isolation passed again after restart.
9. Saved completed state, fully quit and verified a recovery copy; another reopen matched the complete saved state. `work/control-logs-completed-restart.log`.

Screenshots: `outputs/Rerun Control Center Logs after restart.png`, `outputs/Rerun Logs Codex reply after restart.png`.

## Cleanup and remaining scope

Recovery copies are at `work/control-logs-before-recovery/verified-manifest.json` and `work/control-logs-completed-recovery/verified-manifest.json`. Root removed only the two backed-up temporary coworkers through the authenticated app API. Another full quit/reopen confirmed the original workspace/provider defaults, Box geometry and membership, and **2 coworkers / 23 chats / 88 messages** exactly unchanged; no QA fixtures remain. `work/control-logs-clean-final-restart.log`, `work/control-logs-original-final-restart.log`. The app is open on the original board with Codex connected.

This accepts the Control Center Logs slice. The broader B5 group still has remaining scope; the catalog remains **28 unfinished capability groups**. A/B/G/H have new isolated assignments; C/D/E/F continue their existing unfinished tasks. Their new work is not installed or accepted. Root will review and test each returned handoff. See `desktop-next-round.md`.
