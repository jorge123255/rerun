# Round 34 G — Mac-isolated Claude subscription runtime

Source handoff only. Root integration, credential custody, provider execution, packaging and native acceptance remain pending.

## Original source/design mapping

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/engine/src/connections/claude-token.ts` — refresh-token lineage, lease/idle refresh and rejected-credential semantics.
- `apps/engine/src/agents/claude-context.ts` — live query creation, bounded context/plan usage capture.
- `apps/engine/src/agents/claude-stream.ts` — text/tool result adaptation and bounded screenshot handling.
- `apps/engine/src/agents/claude-card-nudge.ts` — Stop-hook continuation rather than a second process.
- `apps/ui/lib/engine/claude-oauth.ts` — actual PKCE authorize URL, `code#state` handling and server-side JSON token exchange. This is not a new device-code flow.
- `apps/ui/components/connections/use-claude-oauth.ts` — single-use PKCE state, manual setup-token fallback and no refresh-material inheritance.
- `apps/ui/components/connections/plan-connect/ClaudePlanSteps.tsx` — original Open Claude, paste code and connected states.
- `apps/ui/app/api/_services/ai-connection.service.ts` — provider-scoped custody, model catalog and no cross-provider sign-in.

Accepted desktop Codex supervisor, runtime, login and isolated home/process boundaries were inspected. The Claude implementation uses an application-managed runner home and explicit custody rather than ambient `~/.claude`, `~/.codex`, existing ChatGPT configuration or CLI sessions.

## Canonical contract and exports

`packages/contracts/src/desktop-claude-plan.ts` provides:

- `DesktopClaudePlanAttempt`: opaque attempt ID, owner/revision, waiting/checking/connected/cancelled/expired/error/disconnected phases, authorize URL, single-use PKCE verifier/state and safe expiry/message. No raw code or token is stored in the snapshot.
- `DesktopClaudePlanCompleteInput` and `DesktopClaudePlanAttemptAction` for bounded complete/cancel/disconnect operations.
- `DesktopClaudePlanOAuth`, `DesktopClaudePlanCredentialCustody`, `DesktopClaudePlanAttemptStore`, `DesktopClaudePlanChatStore`, `DesktopClaudePlanAuthority`, `DesktopClaudePlanRunner` and `DesktopClaudePlanProbe`.
- Strict chat input with `claude-sonnet-4-6` or `claude-opus-5-5` and `adaptive` or `disabled` thinking. Other models/reasoning settings refuse rather than silently changing them.
- Typed text/reasoning/tool/source/usage/finish/error events and bounded saved chat results with exact agent/session/run/tool-call and credential revision.

`apps/engine/src/desktop/claude-plan/auth.ts` implements start/status/complete/cancel/disconnect. `runner.ts` implements bounded dispatch, stream/history capture and exact Stop. UI server modules provide the owner-checked HTTP binder and durable attempt/chat stores. `apps/desktop/src/main/claude-plan.mjs` provides concrete file custody, CLI probing, JSONL process streaming and process-group cleanup.

## Required root wiring

### OAuth and credential custody

Use the original `buildClaudeAuthorize` and server-side `exchangeClaudeCode`; do not substitute a device-code provider or another account. `oauth.start()` returns the original authorize URL, verifier and state. `oauth.exchange()` verifies the exact current attempt and returns `{accessToken,refreshToken?,expiresAt?}`.

`DesktopClaudePlanCredentialCustody` must be the root encrypted/Keychain adapter, with `load/save/clear` and monotonic `revision`. `save` runs only after a confirmed exchange. `clear` runs only for a connected disconnect. Failed/cancelled replacements must not clear an older valid connection. `createFileClaudePlanCredentialCustody` is a concrete isolated-home adapter for fixtures/local composition; it is not permission to use an ambient Claude home.

`desktopClaudePlanHttp` mounts at `/api/desktop/coworkers/[agentId]/claude-plan`:

- POST `{operation:'start'}` returns the current single active owner attempt and original authorize URL.
- POST `{operation:'complete',attemptId,requestId,rawCode,verifier,state}` exchanges once and stores custody.
- POST `{operation:'cancel'|'disconnect',requestId,attemptId,expectedRevision}` preserves unrelated credentials or clears only the exact connected attempt.
- GET `?attemptId=` reads/reconciles expiry without a provider call; `?operationId=` reads a saved chat without dispatch.

F consumes these typed snapshots and does not need to infer a new flow.

### Durable stores and migration

Add `desktopClaudePlanSchema` from `apps/ui/lib/desktop/server/claude-plan/schema.ts` through root’s central migration/bootstrap. `desktopClaudePlanStore(db)` implements exact attempt identity, monotonic attempt revisions, chat reservation and idempotent saved-result completion. No ambient credential or parallel chat store is introduced.

### Runner, provider dispatch and authority

Compose `createDesktopClaudePlanRunner(runner,outcomes,authority)` with the root provider bridge. `authority(identity,signal)` validates current enabled/not-deleting owner, session/run/tool-call, current credential revision, model support and cancellation before dispatch and before delivering a result. Saved results remain readable without calling the provider.

`DesktopClaudePlanRunner.dispatch` must return an async iterable of canonical events. `stop(identity)` must terminate only that exact process group. Follow-up uses a new tool-call identity; saved operation IDs are never used to replay a response.

Root maps compatible settings into its actual Claude Code `createClaudeCode`/CLI integration:

- `model` from the two canonical values; no silent fallback.
- `thinking:'adaptive'` maps to summarized adaptive thinking; `disabled` turns thinking off.
- `persistSession:false`, `strictMcpConfig:true`, `enableFileCheckpointing:false`.
- `cwd` is the application-managed runner home, not the ambient user home.
- `ANTHROPIC_API_KEY` remains unset; `CLAUDE_CODE_OAUTH_TOKEN`, refresh material and expiry come only from custody.
- No `bypassPermissions`, `allowDangerouslySkipPermissions`, automatic shell/tool approval, host filesystem or broad host grant is added. Tools require their existing separate permissions.

`createClaudePlanProcessAdapter` requires `command` (absolute runner path), `argsForChat(identity,input)`, `credentialCustody` and the app-managed `homeDir`. Root supplies those exact version-compatible argv values rather than relying on this lane to guess CLI flags. A missing runner/version returns the real unavailable projection; nothing is downloaded or installed by this package.

### Main-process packaging and readiness

Package the signed Claude runner through root’s existing native bundle/signing path. `probe` runs the bounded `--version` check only when root explicitly asks for readiness. A missing CLI, failed version read or unsupported model is an honest unavailable state. Settings opening performs no spawn, authentication or download.

Root’s Keychain/IPC/startup code supplies custody to `createClaudePlanProcessAdapter`. Main owns only the process group created for that exact chat. Stop uses detached-group SIGTERM followed by bounded SIGKILL, never another chat or system process.

## Implemented / dependent / unsupported matrix

| Area | Status | Dependency or unsupported scope |
| --- | --- | --- |
| Canonical auth contract and single active attempt | Implemented in source | Root exports contract and F mounts operations |
| Actual PKCE exchange and expiry | Implemented in source | Root supplies original OAuth adapter |
| Encrypted credential custody and isolated home | Port/concrete adapters implemented | Root supplies Keychain custody and runner home |
| Bounded start/status/complete/cancel/disconnect | Implemented in source | Root mounts HTTP binder |
| Authenticated chat and stream/history adaptation | Implemented in source | Root supplies real Claude Code runner and provider bridge |
| Exact Stop/process-group cleanup | Implemented in source | Root owns supervisor/IPC and process lifecycle |
| Saved outcomes and restart without replay | Implemented in source | Root supplies central migration and saved-result mount |
| CLI discovery/version readiness | Adapter implemented | Root supplies signed CLI and packaging; missing CLI is unavailable |
| Ambient Claude/Codex session inheritance | Unsupported | No ambient home, existing ChatGPT settings or account fallback |
| New device flow/provider fallback | Unsupported | Only the original Claude OAuth lineage |
| Host shell/tool auto-approval or host package imports | Unsupported | Existing separate permissions remain authoritative |
| Live authentication/provider/native acceptance | Root dependent | No live credential/provider/build/native check was performed |

## Authored, unexecuted regressions

- `auth.test.ts`: coalesced owner attempt, isolated custody, failed replacement preservation, cancel/disconnect custody boundaries and expiry without re-exchange.
- `runner.test.ts`: stream/tool/source/usage events, authority before/after dispatch, restart with zero runner calls, exact Stop/cancel and invalid source protocol refusal.
- `store.test.ts`: attempt revisions, saved chat replay, identity conflicts and missing reservations.
- `claude-plan.test.mjs`: app-managed file custody, real CLI probe shape, JSONL mapping, explicit credential loading and exact process-group termination.

No tests, typecheck, lint, builds, dependency installation, servers, packaging, UI actions, Docker, live APIs/providers, authentication, credential reads or Keychain access was performed. The installed Next.js documentation directory was absent. Root must run every check and repair any defect; no checklist or installed acceptance claim is made.
