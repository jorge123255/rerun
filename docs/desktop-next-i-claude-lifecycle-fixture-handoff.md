# I — Claude lifecycle offline journey

Branch: `desktop/next-i-claude-lifecycle-fixture`
Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-i-claude-lifecycle-fixture`
Base/parent: `7080add37a60bd604965649319143b8211818fd9`
Base tree: `e7db3a3f5df8057ffe86576153a8acff3360481b`
Exact HEAD/tree and clean status verified before editing. Final tip/tree supplied with delivery.

## Original and mounted comparison
Reference: original Rerun dev `c33c020ffb33263ec29de6f76d9b269bca786d90`.
- `apps/ui/components/connections/plan-connect/ClaudePlanSteps.tsx`: approval, paste-code and connected steps; setup-token path.
- `apps/ui/components/connections/use-claude-oauth.ts`: PKCE lifetime in the hook, exchange then save, explicit token replacement, private input reset.
- `apps/ui/lib/engine/claude-oauth.ts`: original exchange transport.

Mac entry: `apps/ui/components/desktop/claude-plan/DesktopClaudePlanSteps.tsx`, `DesktopClaudeLogin.tsx`, `DesktopClaudePlanDialog.tsx`, `DesktopClaudeConnectionDetails.tsx` use the existing desktop runtime/hook.
`apps/ui/lib/desktop/claude-plan-client/runtime.ts` -> `/api/desktop/claude-login` -> `apps/ui/lib/desktop/server/claude-plan/http.ts` -> engine `/desktop/claude-login` -> `apps/engine/src/desktop/claude-plan/auth.ts`.
Engine owns attempt UUID/revision, request fingerprint, predecessor credential generation and PKCE; client journal holds only public request identity. Passive GET/reconcile never exchanges a code or replays POST. Pending replacement preserves the previous connected generation. Cancel invalidates only the captured attempt; publication rechecks exact checking revision/predecessor after exchange. Successful replacement drains workers before changing credentials and reloads the singleton.
Singleton ID remains `mac-claude`. Production auth uses `withConnectionLock`, `connectionEnvPath`, `writeEnvFile`/`readEnvFile`; `apps/engine/src/lib/env-file.ts` seals desktop credentials with AES-256-GCM and mode 0600. No encryption, key management, identity or custody code changed or exercised by these in-memory fixtures.

## Evidenced local defect and fix
`DesktopClaudeConnectionDetails` treats `credentialRejected` as unusable. `connections/loader.ts` intentionally publishes `connected:true, credentialRejected:true` when a token remains saved but rejected. Before this patch, `apps/ui/lib/desktop/chat-model.ts:usableConnection` considered only connected/model membership and therefore marked that Claude selection available. `buildDesktopModelView` and server chat-model selection share this function.
The scoped fix rejects explicitly rejected **Claude** credentials while retaining the saved selection and existing handling for other providers. This is static source evidence, not an executed test verdict. The journey's rejected-connection case is a parent negative control: its expected unavailable result contradicts the old predicate. Authentication, provider rejection recording and encrypted storage are unchanged.

## Changed files / authored regressions
- `apps/engine/src/desktop/claude-plan/lifecycle.journey.test.ts`: real auth state machine over synthetic serialized custody/lock/exchange ports. Initial sign-in, exact duplicate receipt/no second exchange, passive new-launch status, held reconnect superseded by another attempt, stale completion refused, cancel keeps old generation, successful reconnect drains and increments generation, rejected initial/replacement exchanges redact errors and preserve old credential, disconnect removes it.
- `apps/ui/lib/desktop/claude-plan-client/lifecycle.journey.test.ts`: real client/model projection with scripted offline HTTP DTOs. Not eligible before sign-in; eligible after; restart only GET; rejected saved credential becomes unavailable without changing selection; old completion/cancel cannot POST against replacement; journal excludes code and providers retain one singleton identity.
- `apps/ui/lib/desktop/chat-model.ts`: Claude rejection guard and optional typed rejection field.
- this handoff.

Fixture values are synthetic. Auth-generated PKCE/attempt values are intentionally opaque; timing and exchange outcomes are controlled, no native process/provider/browser/account is invoked. Engine and UI journeys exercise separate seams: the scripted HTTP transport is not an end-to-end real route/engine test. The real authenticated desktop route and secure disk persistence remain root acceptance gates. Existing auth.test.ts, runtime.test.ts, client runtime/use-hook tests, ClaudePlanSteps and ConnectionDetails mounted tests, credential-rejection/loader and server chat-model suites remain relevant. Root should execute both new journeys on this tip and the model regression on parent as a negative control.

## Integration and remaining gates
No new mount, route, registry, provider, default or migration. Existing shared model projection/server selection picks up the guard. Root owns all test execution/builds and integration review; no tests, typecheck, lint, formatter, build, install or native QA ran. Installed Next docs were absent; no Next API introduced.

Root Mac board/restart procedure (real-account steps require separate authorization):
1. From the board open Claude subscription settings. Unconfigured state cannot offer a usable Claude reply selection. Start sign-in, complete only the displayed attempt; one singleton appears and a reply becomes eligible after saved connection acknowledgement.
2. Cold restart. Saved connection and selection survive; opening settings/history performs passive reconciliation with no sign-in POST or token exchange.
3. Start reconnect A, supersede it with B; late A result and closing A must not cancel B or publish credentials. Cancel B and verify old saved connection is preserved. Successfully reconnect and verify worker drain before replacement and changed credential generation.
4. Exercise synthetic rejection/unavailable fixtures first. A rejected credential must show rejected/blocked availability, preserve the selected model, and recover only after successful credential replacement. Initial rejection must not create a usable credential. Rejected replacement must not erase the old saved token.
5. Close/cancel and disconnect cases must keep exact attempt identity, stop pending work, and prevent late callbacks from restoring a removed credential. Confirm no token/code/verifier in renderer state, journal, public DTOs or diagnostics.

Limits: provider-rejection flags are currently in-memory by existing engine design; after process restart a subsequent provider failure can mark rejection again. This patch does not add persistent rejection policy. Live provider acceptance, reply execution, encrypted disk/Keychain behavior, app permission/sandbox behavior and cold restart are unverified. No real account login, provider call, push, PR, installation, VM or permission changes.
