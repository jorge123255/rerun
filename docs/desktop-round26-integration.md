# Round 26 integration and root acceptance

Status: E private file edits, G description creation and root To handle passed native/full-restart acceptance in 1b94f86. MCP OAuth refusal/retry was observed; a real provider OAuth sign-in remains unverified.

Original design reference: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

## Integrated work

- E `a4296eb3cfa5daab60cb95c656cdba40dddf3fca`: private `fs_write` and `fs_edit`. Root registered them behind the per-coworker Edit workspace files grant, added live run/owner/grant authority, deadline handling, strict snapshots, durable unchanged receipts and retained recovery backups. Original source: `apps/engine/src/tools/builtin/fsTools.ts`; Mac uses the existing private Files publisher.
- F `9c8959e021cc3318cca824223191a544c4c1e8eb`: MCP public-client OAuth. Root fixed public-address validation, discovery, cancellation, attempt lifetime and interrupted refresh persistence; wired the existing authenticated MCP service and saved-server row. Public HTTPS, PKCE/DCR and issuer validation are required. A real provider sign-in remains a separate acceptance claim.
- G `b08f3af5ab61fd06fadfc6b3c6381b3e05600cfc`: original description composer and board placement. Root added durable creation/placement/first-chat/acknowledgement receipts, atomic engine publication, protected unfinished creation and atomic first-turn input persistence. Original sources: `components/dialogs/new-agent/NewAgentForm.tsx`, shared `@rerun/ui/new-agent`, and the existing IsoGrid placement controls. Description stays the exact opening message; it is not generated permanent instructions. Templates, connector setup and scheduled creation remain unavailable. Codex uses the original deterministic name fallback; typing suggestions do not launch a subscription runner with file tools.
- Root B5 slice: original coworker To handle entry opens Chats → Needs you, with shared InboxRow rendering, durable exact-request read receipts, fresh navigation checks and bulk confirmation. Original sources: `components/agent/AgentPanel.tsx:126`, `components/control-center/ControlCenter.tsx:293` and `AGENT_TABS`. Mark as read does not answer or approve.

## Root verification record

Only root ran checks, packaging and Mac QA. Initial broad UI run covered 4,558 passing tests, one obsolete creation-focus assertion and 39 skips; the corrected targeted run passed 28 tests. Engine broad run covered 3,337 passing tests and one additive migration expectation; the corrected targeted run passed 114 tests. Both type checks passed. Shell tests passed 20; changed UI lint had no errors and 100 warnings. Final file-instruction/provider checks passed 34 tests in the dependency-equipped build worktree. Production builds, native runtime verification, strict signature verification and installation passed.

The disposable Round26 QA coworker was created through the original description composer and board placement. Its first real Codex reply was READY26; the exact owner, placement, first chat and creation receipt survived restart. A plain fresh-chat request in 1b94f86 invoked Write File, Edit File and Read File, returning FRESH AFTER. An earlier file preview remained ROUND26 AFTER after restart. The app-specific tool instructions now distinguish granted workspace publication from Codex's native temporary filesystem.

Control Center To handle opened Chats -> Needs you. Mark all as read used the original confirmation, changed the count to zero and retained the unanswered approval. Both the zero count and untouched approval survived full restart. MCP authorization showed the permission refusal while disabled and the unsupported-provider/Retry sign-in state for https://example.com/mcp when enabled. No real external account sign-in is claimed.

Root quit the canonical app and verified full recovery snapshots before updates and restart. The original two coworkers retain 23 chats and 88 exact messages. Round26 QA remains for the next acceptance run; it was not deleted. No credentials appear in this report.

## Remaining acceptance

- Real public-client MCP OAuth sign-in requires a compatible provider and user browser approval.
- Native queue transition, actual macOS banner/click delivery and broader capability scopes remain separately tracked.
- Round27 integrates PDF text, image inputs, Shared files, notification surfaces and skill suggestions; its Mac acceptance is separate from the above record.
