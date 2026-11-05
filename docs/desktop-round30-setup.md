# Round 30 C — setup instructions and durable first-install chat (B4)

Original references at `a6d63a4`: `apps/engine/src/agents/setup.ts` (hasPendingSetup/markSetupComplete/claimInstallSession), `apps/engine/src/tools/builtin/install.ts` (install_complete + hosted activateAutomations), `packages/contracts/src/agent.ts` (agentSetupSchema/isSetupAnswered), `apps/ui/hooks/useAgentSetup.ts`, `apps/ui/components/agents/AgentPanelSetup*` / `AgentSetupFields` (author-save vs installed-copy semantics).

## What this lane adds

- `packages/contracts/src/desktop-setup.ts` — `DesktopSetupView` (owner agentId, revision, required/prompt/completedAt/sessionId/pending/skipped, safe `defaultPrompt`), discriminated `save|start|continue|skip` mutations with `requestId` + `expectedRevision`, `DesktopSetupMutationResult`.
- `apps/engine/src/desktop/setup/service.ts` — `readDesktopSetup`, `saveDesktopSetup` (author save completes the author's own setup, writes INSTALL.md), `claimDesktopSetupSession`/`continueDesktopSetupSession` (reuses original `claimInstallSession`; continue never creates a second chat), `initializeImportedSetup` (idempotent per `{agentId, importReceiptId}`, writes pending setup + receipt marker), `desktopSetupRunAllowed` (claimed-session gate), `desktopSetupTools` (install_complete restricted to the claimed session, idempotent, **no** `activateAutomations` — no hosted schedule/webhook side effects, no tool grants).
- `apps/engine/src/desktop/setup/routes.ts` — `GET /`, `POST /save|/claim|/continue` under `/agents/:id/setup` for root mounting.
- `apps/ui/lib/desktop/server/setup/service.ts` — authenticated view assembly (engine record + durable skip + desktop session reconcile), UUID request receipts (`desktop_setup_mutations`), skip state (`desktop_setup_state`), scoped events (`desktop_setup_events`), expected-revision 409s. Start/Continue clear skip; Continue without a claim refuses (engine 409 propagates); the desktop session row is reconciled from the claimed engine session so a lost reply/restart resumes the same chat.
- `apps/ui/app/api/desktop/coworkers/[agentId]/setup/route.ts` — GET view + POST actions through `desktopRoute`.
- `apps/engine/src/desktop/setup/service.test.ts` — author-save, import idempotency, single-claim/continue reconcile, continue-refusal, run gate.

## Root wiring fragments

1. `packages/contracts/src/index.ts`: add `export * from './desktop-setup.js'` (lane files import `@rerun/contracts`; unresolved until this lands).
2. `apps/engine/src/http/server.ts`: `import { desktopSetupRoutes } from '../desktop/setup/routes.js'` and `api.route('/agents/:id/setup', desktopSetupRoutes)`.
3. `apps/engine/src/tools/registry.ts` (~line 107): replace the install gate for the desktop app:
   ```ts
   if (hasPendingSetup(ctx.agent)) {
       if (desktopApp()) { if (desktopSetupRunAllowed(ctx.agent, ctx.sessionId)) Object.assign(tools, desktopSetupTools(ctx)) }
       else Object.assign(tools, installTools(ctx))
   }
   ```
   (`desktopApp`, `desktopSetupRunAllowed`, `desktopSetupTools` imports; execute also re-validates the claim under the agent lock, covering later question/service-response turns in the same session.)
4. A's import boundary: after creating the fresh coworker, call `initializeImportedSetup({ agentId, engineAgentId, importReceiptId, prompt, required, signal })` engine-side; it is idempotent for the exact import identity.
5. D consumes `GET/POST /api/desktop/coworkers/[agentId]/setup` and the contract types; `defaultPrompt` is the safe Mac prompt (no `.env`/login promises).
6. Desktop DB: the setup module creates `desktop_setup_state`, `desktop_setup_mutations`, `desktop_setup_events` itself via `CREATE TABLE IF NOT EXISTS` on first use — no central migration required, but root may prefer moving them into `database.ts`.

## Semantics kept / changed

- `setup.required/completedAt/sessionId` and INSTALL.md meaning preserved; author save completes author setup; imported copies pending via `initializeImportedSetup`.
- Skip is durable server-side (`desktop_setup_state`), distinct from `completedAt`, and cleared by explicit Start/Continue. It does **not** activate automations (hosted `useAgentSetup.skip` called `activateAgentAutomationsAction`; that side effect is intentionally absent).
- `install_complete` exists only inside the claimed setup chat (any run in that session, including follow-up turns), is idempotent (`alreadyComplete`), and never activates schedules/webhooks or enables tools.
- First-install events are append-only rows; no history/draft tables touched.

## Limits / pending root

- No template capture/import (lane A), no UI components (lane D), no chat-admission changes.
- `desktopSetupTools` assumes `ctx.sessionId` is the engine session id (RunContext field confirmed); registry fragment is required for the tool to appear only in the claimed chat.
- All tests/typecheck/lint/build/packaging/native QA pending root; nothing executed in this lane.
