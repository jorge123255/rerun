# I — Mounted Claude reconnect with fake transport
Base/parent: aff68bebd97380edb3a70424bd2a7ff212affaab
Base tree: b0dd6e0c3c5c05405670f16aff31c66813f74673
Branch: desktop/next-i-claude-mounted-reconnect
Worktree: /Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-i-claude-mounted-reconnect
Clean exact pin verified before edits. Final tip/tree supplied in delivery.

## Joined fixture
apps/ui/components/desktop/claude-plan/DesktopClaudeMountedReconnect.test.tsx mounts actual DesktopSettings, DesktopClaudeLogin/Steps, hook/client and DesktopModelSelector. Fake fetch routes /api/desktop/claude-login through the actual GET/POST export, desktopClaudePlanHttp and desktopRoute/authenticateDesktopRequest. Only readDesktopRuntime is synthetic; real host/origin/session-cookie checks run and wrong cookie gets 401.
The internal engine transport delegates to actual createDesktopClaudePlanAuth with a serialized synthetic custody port and deterministic exchange. readDesktopProviders projects one saved mac-claude connection. Model endpoint uses actual buildDesktopModelView; the picker is real. A clearly labelled fixture-only reply endpoint returns one synthetic reply after eligibility; no runAgent, Claude CLI or provider is invoked.
Journey: saved rejected credential -> Settings reconnect control -> delayed completion -> Cancel -> stale completion refused -> fresh reconnect -> same singleton/default model -> one synthetic reply -> new auth instance/retained custody and passive GET -> restored connected Settings with unchanged selection. No browser/network opens: window.open is stubbed. LocalStorage is an isolated fixture map; journal must not contain code.
This is a mounted Vitest fixture driven via Settings controls, not a shipped fixture mode or a new production Settings route. No fixture transport is registered in production.

## Source seam defects / bounded fixes
On PR23 base, DesktopClaudeLogin renders Steps for rejected=true, but useDesktopClaudePlan.linked is true whenever an old credentialRevision exists. Steps then disables Open and CodeInput, so a rejected saved connection cannot reconnect. The mounted expectation is a parent negative control, UNRUN.
A replacement exchange error still projects phase connected for the prior token; submit previously treated that phase alone as success. The focused hook regression requires an error-free completed replacement with new credential revision instead.
Changes:
- apps/ui/lib/desktop/claude-plan-client/use-desktop-claude-plan.ts adds opt-in reconnect projection tracking initial credential generation, retaining the old generation in engine custody. Completion requires no error/pending attempt; reconnect requires a changed credential generation.
- use-desktop-claude-plan.test.tsx adds focused rejected replacement regression.
- DesktopClaudePlanSteps.tsx forwards optional reconnect.
- DesktopClaudeLogin.tsx enables it for rejected saved credentials.
- DesktopClaudeConnectionDetails.tsx enables it in its existing unavailable/rejected reconnect surface.
- apps/ui/components/desktop/DesktopSettings.tsx excludes explicitly rejected Claude models from usable default picker options while retaining providers.default unchanged.
- mounted fixture above and this handoff.
Other providers, credential store, singleton, route authentication, engine auth, current selection, model guard and profile are unchanged. No new identity/multi-account support.

Original reference c33c020ffb33263ec29de6f76d9b269bca786d90: components/connections/use-claude-oauth.ts and plan-connect/ClaudePlanSteps.tsx. Current exact-attempt authority: apps/engine/src/desktop/claude-plan/auth.ts; secure custody: engine lib/env-file.ts. Existing original/public credentials are never loaded by this fixture.
No central mount or migration needed for the reconnect prop: existing Settings and details components forward it. Root runs the mounted fixture + existing auth/client/hook/details/settings/model suites, including parent negative controls, then builds and performs sandboxed Mac board/cold-restart QA.

## Honest validation boundary
ALL test execution/typecheck/lint/build/native QA remain UNRUN. Source defects are evidenced by the mounted path and boolean/phase trace; no executed reproduction/PASS claim. The authored fixture may need root-run adjustments; no test failure was hidden or bypassed.
Persistence here means recreated auth/client/components over retained synthetic custody, not actual encrypted disk/Keychain or process restart. Model/reply transport is fake; the actual Claude login desktop route/auth is joined. No provider call, native process, real account login, install, VM/permission/profile change, push or PR.
Root acceptance: drive rejected Settings reconnect in the sandbox app; verify Cancel preserves old connection, stale completion cannot replace it, successful replacement drains workers, selection survives cold restart and only the new generation enables reply. Any real-account login needs separate authorization. Rejection flags retain the existing in-memory engine policy; no new persistence policy is introduced.
