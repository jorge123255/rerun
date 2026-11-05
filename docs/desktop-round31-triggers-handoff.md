# Desktop Round 31 — Triggers source handoff (E9 + B5 + C8)

## Status

Source implementation + authored regression sources only.  
**No tests, typecheck, lint, builds, installs, app servers, packaging, Mac UI, provider/API calls, webhook deliveries, Docker, Keychain or network setup were executed by this lane.**  
**Not accepted. E9 is not marked complete.** Root retains all checks, corrections, board/live/full-restart acceptance, and checklist updates.

Prepared worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round31-triggers-full`  
Branch: `desktop/round31-triggers-full`  
Base: `aa35cc841b9d5c20246b4a095c910775af572d52`  
Original: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`

## Original → adapter mapping

| Original (`a6d63a4`) | Desktop adapter |
| --- | --- |
| `packages/contracts/src/trigger.ts` | `packages/contracts/src/desktop-triggers.ts` (extends with revision/requestId/receipt/stop/ingress origin) |
| `apps/engine/src/triggers/loader.ts` | Authority callbacks `list/read/write/rotate/delete/markFired` + lifecycle wrapper |
| `apps/engine/src/triggers/message.ts` | `apps/engine/src/desktop/triggers/message.ts` |
| `apps/engine/src/triggers/url.ts` | URL built only when `ingressOrigin().enabled`; otherwise honest unavailable |
| `apps/engine/src/http/routes/triggers.ts` | Lifecycle + ingress dispatch (token compare, 404/405) |
| `apps/engine/src/runtime/trigger-runner.ts` | `dispatch.ts` → injected `startTriggerRun` |
| `apps/engine/src/tools/builtin/trigger.ts` | `tools.ts` factory (secret-free list/get) |
| `apps/ui/app/api/t/.../route.ts` | `ingress.ts` handler factory (**unmounted**) |
| `apps/ui/lib/triggers/webhook.ts` | `webhook-body.ts` |
| `apps/ui/lib/triggers/passive-visit.ts` | `passive-visit.ts` |
| `apps/ui/lib/triggers/trigger-payload.ts` | `apps/ui/lib/desktop/triggers/payload.ts` → `@rerun/contracts` |
| `AgentPanelTriggers.tsx` | `DesktopCoworkerTriggers.tsx` |
| `TriggerEditor.tsx` | `DesktopTriggerEditor.tsx` |
| `TriggerUrlField.tsx` | `DesktopTriggerUrlField.tsx` |
| `AgentRunHistory.tsx` / runs step | `TriggerRuns` inside `DesktopCoworkerTriggers.tsx` |
| `TaskOutcomeFooter.tsx` | Simplified last-call footer (outcomes optional; root may wire) |
| `WebhookRunBlock.tsx` | `DesktopWebhookRunBlock.tsx` |
| `TriggerPayloadBlock.tsx` | `DesktopTriggerPayloadBlock.tsx` |
| `ControlCenter.tsx` coworker Open → Triggers | `panel-adapter.ts` + `DesktopCoworkerTriggersPanel.tsx` |

## Changed files (owned only)

- `packages/contracts/src/desktop-triggers.ts`
- `apps/engine/src/desktop/triggers/**`
- `apps/ui/lib/desktop/server/triggers/**`
- `apps/ui/lib/desktop/triggers/**`
- `apps/ui/components/desktop/triggers/**`
- `apps/ui/app/api/desktop/coworkers/[agentId]/triggers/route.ts`
- `docs/desktop-round31-triggers-contract.md`
- `docs/desktop-round31-triggers-handoff.md`

Root must still re-export `desktop-triggers` from the contracts package index if other packages import via barrel (not edited here).

## Exact root integration dependencies

### 1. Promote grant + authorize

`trigger` is currently a **pending** catalog entry and is **not** in `desktopRerunGrantIds`. Root must:

1. Add `'trigger'` to `desktopRerunGrantIds` and mark catalog entry `supported` when ready
2. Implement authorize that checks current exact local↔engine identity, enabled, not deleting, and `desktopRerunGrantsOf(...).trigger`
3. Pass that authorize into `desktopTriggerRequest` / engine `DesktopTriggerAuthority.assertTriggerGrant`

Do **not** use `authorizeDesktopTriggersBasic` alone in production — it intentionally does not invent an allow-all grant.

### 2. Engine authority + schema

```ts
import { bindDesktopTriggers, desktopTriggerStateSchema } from './desktop/triggers/index.js'
import { getSystemDb } from './db/systemDb.js'

// After reconcileInterruptedRuns, before admissions:
for (const engineAgentId of localEngineAgentIds) {
  if (desktopDeletionPending(engineAgentId)) continue
  const { client } = await getSystemDb(engineAgentId)
  await client.executeMultiple(desktopTriggerStateSchema)
}

const triggers = bindDesktopTriggers({
  getSystemClient: async id => (await getSystemDb(id)).client,
  authority: rootDesktopTriggerAuthority, // REQUIRED — fail closed
  networking: createDisabledDesktopTriggerNetworking(), // until hosting decision
})

// Startup recovery (no provider replay):
for (const id of localEngineAgentIds) await triggers.recoverOwner(id)

// Quit:
await triggers.close()
```

`rootDesktopTriggerAuthority` must wrap existing: agent registry enabled check, setup gate (`assertDesktopSetupChatAllowed` / engine setup), automation model resolver, `createSession(..., 'trigger')` + `startHeadlessRun(..., { source:'trigger', slug, name })`, `cancelRun`, session/run reads, UI adoption bridge (`desktop.trigger.adopt`), and human routing into existing question/approval/app/takeover callbacks.

### 3. UI bridge + panel

```ts
// engine-callback.ts — after auth:
import { handleDesktopTriggerBridge } from '@/lib/desktop/server/triggers'
const handled = await handleDesktopTriggerBridge(runtime, body, signal)
if (handled) return handled
```

```tsx
import { DesktopCoworkerTriggersPanel } from '@/components/desktop/triggers'
import { createDesktopTriggersOpenCommand } from '@/lib/desktop/triggers'

<DesktopCoworkerTriggersPanel agent={coworker} onOpenChat={openLocalChat} ingressAvailable={false} />
// Control Center: wire createDesktopTriggersOpenCommand(agentId => openCoworkerPanel(agentId, 'triggers'))
// after adding 'triggers' to DESKTOP_COWORKER_PANELS.
```

```tsx
// DesktopConversation transcript branch (root-owned edit):
import { DesktopWebhookRunBlock } from '@/components/desktop/triggers'
import { parseTriggerPayload } from '@/lib/desktop/triggers'
const payload = parseTriggerPayload(messageText)
if (payload) return <DesktopWebhookRunBlock agentId={agentId} payload={payload} />
```

### 4. Ingress mount (only after hosting decision)

```ts
import { createDesktopTriggerIngressHandler } from 'engine/desktop/triggers'
const ingress = triggers.createIngressHandler({ resolveEngineAgentId })
// Mount ONLY after explicit hosting choice. Default remains unmounted.
// Do not publish a Mac loopback address as externally reachable.
```

### 5. Coworker deletion

On delete: `await triggers.lifecycle.revokeCoworker(engineAgentId)` and/or bridge event `desktop.trigger.revoke` so ingress authority closes.

### 6. Contracts export

Root adds `export * from './desktop-triggers.js'` (or named exports) to `packages/contracts/src/index.ts` — not done in this lane.

## Durable / restart / networking assumptions

- Definitions live in existing engine trigger files; revisions/receipts/events in additive system DB tables
- Lost ACK replays durable mutation result; rotate/delete require matching `expectedRevision`
- Independent webhook calls are distinct events; body equality never collapses them
- Restart marks in-flight events uncertain; never relaunches provider work
- Networking default: disabled / loopback / unresolved hosting; `start()` refuses to bind sockets

## Authored regressions (not executed)

Engine: `state.test.ts`, `passive-visit.test.ts`, `ingress.test.ts`, `lifecycle.test.ts`, `stop.test.ts`, `message.test.ts`  
UI server: `adoption.test.ts`, `api.test.ts`  
UI components: `DesktopCoworkerTriggers.test.tsx`, `DesktopWebhookRunBlock.test.tsx`

Coverage intent: lifecycle/conflicts, lost ACK, rotate/revoke, passive visits, payload caps, wrong owner, disabled/deleting/setup/grant admission, separate events vs exact retries, one-time adoption, restart/Stop, UI Cancel/draft/stale coworker, original empty/divider labels.

## Remaining limitations

- Ingress unmounted; external delivery unresolved
- Grant catalog still pending until root promotes `trigger`
- DesktopConversation / Control Center / coworker-panel lists not edited
- Model tools not registered in central tool registry
- Process-local revision fallback in UI API is only a mount-safety default; production must pass engine durable store
- TaskNotifyField / template content lock / hosted RunModelField not ported (desktop uses coworker local model override string)
- No packaged Mac app verification by this lane

## Commit

See git log on `desktop/round31-triggers-full` for the full SHA of this handoff commit.
