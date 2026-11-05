# Round 26 integration and root acceptance

Status: source integration and regression review in progress; this file does not claim Mac acceptance yet.

Original design reference: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

## Integrated work

- E `a4296eb3cfa5daab60cb95c656cdba40dddf3fca`: private `fs_write` and `fs_edit`. Root registered them behind the per-coworker Edit workspace files grant, added live run/owner/grant authority, deadline handling, strict snapshots, durable unchanged receipts and retained recovery backups. Original source: `apps/engine/src/tools/builtin/fsTools.ts`; Mac uses the existing private Files publisher.
- F `9c8959e021cc3318cca824223191a544c4c1e8eb`: MCP public-client OAuth. Root fixed public-address validation, discovery, cancellation, attempt lifetime and interrupted refresh persistence; wired the existing authenticated MCP service and saved-server row. Public HTTPS, PKCE/DCR and issuer validation are required. A real provider sign-in remains a separate acceptance claim.
- G `b08f3af5ab61fd06fadfc6b3c6381b3e05600cfc`: original description composer and board placement. Root added durable creation/placement/first-chat/acknowledgement receipts, atomic engine publication, protected unfinished creation and atomic first-turn input persistence. Original sources: `components/dialogs/new-agent/NewAgentForm.tsx`, shared `@rerun/ui/new-agent`, and the existing IsoGrid placement controls. Description stays the exact opening message; it is not generated permanent instructions. Templates, connector setup and scheduled creation remain unavailable. Codex uses the original deterministic name fallback; typing suggestions do not launch a subscription runner with file tools.
- Root B5 slice: original coworker To handle entry opens Chats → Needs you, with shared InboxRow rendering, durable exact-request read receipts, fresh navigation checks and bulk confirmation. Original sources: `components/agent/AgentPanel.tsx:126`, `components/control-center/ControlCenter.tsx:293` and `AGENT_TABS`. Mark as read does not answer or approve.

## Root verification record

Only root executes checks, packaging and Mac QA. Internal helpers authored/reviewed source and regression cases without executing them. Initial full UI run: 4,525 passed, 3 integration-fixture failures, 39 skipped; those failures are being corrected. Engine second full run: 3,337 passed, one expected new-migration snapshot mismatch; the v7 snapshot was verified to add only the first-turn receipt table and preserve all v6 table schemas. Final checks supersede these initial runs.

Before installation, root fully quit the canonical app and verified a recovery copy of every workspace file at the task scratch directory `work/round26-before-install`. The original two coworkers retain 23 chats and 88 exact messages. No credentials are included in acceptance output.

## Remaining acceptance

- Complete final source checks and install one canonical Mac app.
- Create from the original description dialog, place on the board, observe a real Codex first reply and exact one-coworker/one-first-message persistence after restart.
- Exercise private write/edit from chat and inspect the saved file after restart; ensure grants and owner isolation remain correct.
- Exercise To handle, exact navigation, read receipts and unanswered approvals across restart.
- Verify MCP authorization UI; distinguish unsupported-provider/error/cancel behavior from a real approved OAuth connection.
- Remove only backed-up temporary QA coworkers, restart and verify original chats and messages are unchanged.
