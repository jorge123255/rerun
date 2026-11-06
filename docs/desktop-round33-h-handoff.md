# Round 33 — Lane H handoff: E11 Foreman presentation

Status: **source only, unverified.** No tests, typecheck, lint, build, server, UI, provider, Docker,
native Mac or restart checks were run. Not accepted; E11 presentation is not marked complete.
Root runs every check and installed-Mac / full-restart acceptance.

Prepared worktree `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round33-foreman-ui`,
branch `desktop/round33-foreman-ui`, exact base `56fdce61a780e005644057cc77d8edebbf0d067a`.
No prior lane work existed. `node_modules/next/dist/docs` is not installed here; components are
client-only and do not use Next-specific APIs.

## Canonical contract (I-owned, read-only)

Read from `round33-foreman-runtime/packages/contracts/src/desktop-foreman.ts` (contract version **1**).
**H did not copy that file** into this worktree and does not own durable types.

Presentation adapters structurally match I's exported names:

| I export | H consumption |
| --- | --- |
| `DesktopForemanChatRef` (`workspaceId`, `chatId`) | `parseDesktopForemanChatRef`, persistence, decisions |
| `DesktopForemanBinding` / live run | `live` prop on column/hook; historical when `null` |
| `DesktopForemanRevision` / sealed plan | `DesktopTrustedPlanSnapshot` + `projectPlanCard` |
| `DesktopForemanDecisionInput` (`confirm` / `ask_changes` + digest) | `DesktopPlanDecisionRequest` |
| `FOREMAN_DECISION_STATES` | pending / acknowledged / failed / uncertain UI |
| `DesktopForemanBuild` / items / setup | `fromContractBuild`, build progress, lead next steps |
| `DesktopForemanDiscoveryEvent` / findings | discovery overlay; unavailable collectors stay visible |
| `foremanNavigationIntentSchema` | live-only `canDispatchForemanNavigation` |
| `DesktopForemanConversationView` | `plans.readConversationView`; `blocked` fail-closed |
| `applyForemanDiscoveryEvent` / `DESKTOP_FOREMAN_SOURCE_LABELS` | mirrored in client for overlay; prefer contract helper once exported |

### Discrepancies / root dependencies

1. **`@rerun/contracts` export missing in this worktree.** Root must add `export * from './desktop-foreman.js'` to `packages/contracts/src/index.ts` when merging I, then H can switch structural mirrors to `import type { … } from '@rerun/contracts'`.
2. **Decision `ask_changes` requires non-empty `feedback`.** UI defaults to `"Please change the plan."` when the outline button is used without a free-text prompt; root/composer can inject a change dialog later.
3. **I identity findings force `logoUrl: null`.** Cards show name/one-liner/attribution URL only.
4. **I discovery findings are only** identity / audience / products / customers / competitors. Older decorative kinds are not rendered.
5. **`open_setup` intent has `agentId` only** (no sessionId). Lead start still reads `setup.sessionId` from build for open_coworker when available.
6. **Late I additions (re-read before commit):** `foremanRevisionSchema.model` and `foremanDecisionSchema.feedback`. Presentation does not require revision.model on the card; decision feedback is carried on ask_changes requests.
7. **Routines are not in I's contract.** Presentation uses injected `DesktopForemanRoutinesPort`; unavailable capability is honest empty state. Creating schedules from historical cards is unsupported (`createFromHistory` forbidden).

## Changed files (all owned)

### `apps/ui/lib/desktop/foreman-client/**`

- `identity.ts`, `plan-view.ts`, `decision.ts`, `build-progress.ts`, `discovery-view.ts`
- `next-steps.ts`, `navigation.ts`, `persistence.ts`, `actions.ts`
- `contract-expectations.ts`, `index.ts`
- `foreman-client.test.ts` (authored, **unrun**)

### `apps/ui/components/desktop/foreman/**`

- Shell: `DesktopForemanColumn`, `DesktopForemanDock`, `DesktopForemanChatLayer`, `DesktopForemanHeader`,
  `DesktopForemanTabs`, `DesktopForemanWelcome`, `DesktopForemanComposer`, `DesktopForemanNextSteps`,
  `DesktopForemanRoutines`, `DesktopForemanBuildProgress`, `useDesktopForemanUi`, `index.ts`
- Plan: `plan/DesktopPlanCard`, `plan/DesktopPlanLifeScene`, `plan/DesktopPlanBoardPreview`, `plan/plan-scene.ts`
- Discoveries: `discoveries/DesktopBoardDiscoveries`, `DesktopDiscoveryCard`, `DesktopDiscoveryStack`,
  `DesktopDiscoveryStatusPill`, `DesktopDiscoveryTeaser`
- `DesktopForemanUi.test.tsx` (authored, **unrun**)

### Docs

- `docs/desktop-round33-h-handoff.md`

## Original source mapping (`a6d63a4b542674ddd002e51b39ba0df6e0807bcc`)

| Original | Local |
| --- | --- |
| `ForemanColumn.tsx` | `DesktopForemanColumn` + `useDesktopForemanUi` (injected ports; no Zustand foreman store) |
| `ForemanDock.tsx` | `DesktopForemanDock` (orb open/close; board stays visible; no hosted pill/voice yet — root wires) |
| `ForemanChatLayer.tsx` | `DesktopForemanChatLayer` (welcome, messages, plan/build/next-steps; simplified message stack) |
| `ForemanTabs.tsx` / `@rerun/ui/foreman` `ForemanTabsBar` | `DesktopForemanTabs` (reuse package bar) |
| `ForemanWelcome.tsx` | `DesktopForemanWelcome` (`Orb` + shimmer labels) |
| `ForemanComposer.tsx` / slot | `DesktopForemanComposer` thin shell; root injects real composer/voice/model |
| `ForemanHeader.tsx` / `ForemanHeaderBar` | `DesktopForemanHeader` |
| `ForemanNextSteps.tsx` | `DesktopForemanNextSteps` (lead setup via I `start_lead_setup`; no billing/checkout) |
| `ForemanRoutines.tsx` / `RoutineList` | `DesktopForemanRoutines` (injected list; honest unavailable) |
| `widgets/PlanCardWidget.tsx`, `plan-card.ts`, `PlanLifeScene.tsx` | `DesktopPlanCard`, `plan-view`, `DesktopPlanLifeScene` |
| `lib/foreman/plan-scene.ts` | `plan/plan-scene.ts` (`desktopPlanScene` / card scene; `findRadialRect` reuse) |
| `builder/discoveries/*`, `lib/company/explore/findings.ts` | `discoveries/**` + `discovery-view.ts` (I event vocabulary) |

## Exported API

From `@/lib/desktop/foreman-client`: identity parsers/gates, plan projection, decision lifecycle,
build/discovery/next-step/navigation/persistence helpers, `DesktopForemanActionPorts`,
`DESKTOP_FOREMAN_CONTRACT_EXPECTATIONS`.

From `@/components/desktop/foreman`: column, dock, chat layer, plan card/preview, discoveries overlay,
`useDesktopForemanUi`.

## Root wiring (not edited)

1. **Export I contract** from `@rerun/contracts`.
2. **Mount** `DesktopForemanDock` + `DesktopForemanColumn` from `DesktopApp` / board split — do not
   let this package mount centrally. Keep the board visible.
3. **Inject** `DesktopForemanActionPorts`:
   - `conversation.sendMessage` / `stop` / optional `focusComposer`
   - `decisions.submit` → I decision route (exact `planId`+`revisionId`+`digest`)
   - `build.readProgress` / `build.act` (`start_lead_setup` / stop / resume)
   - `plans.readShownPlan` / `readConversationView`
   - `discovery.subscribe` + `capabilities` (unavailable collectors honest)
   - `navigation.dispatch` (live observer only)
   - `routines.list`
   - `persistence.load/save` for open/tab/draft/pending plan/decision/build
4. **Pass** trusted `live: { runId } | null` from I conversation view. Historical (`null`) must not
   navigate, start setup, or run discovery effects.
5. **Composer / voice / model / provider** remain root-owned; swap `DesktopForemanComposer` for the
   desktop composer when wiring.
6. **Plan board preview:** root can also feed `desktopPlanScene` tiles into the real board layer
   (same as original `setPlanPreview`).

### Suggested mount snippet

```tsx
import { DesktopForemanColumn, DesktopForemanDock, DesktopBoardDiscoveries } from '@/components/desktop/foreman'
import type { DesktopForemanActionPorts } from '@/lib/desktop/foreman-client'

const ports: DesktopForemanActionPorts = { /* root adapters to I server routes */ }
const chat = { workspaceId, chatId }
const live = conversationView?.live ? { runId: conversationView.live.runId } : null

<>
  <DesktopForemanDock open={foremanOpen} onToggle={() => setForemanOpen(v => !v)} activity={orbState} />
  {foremanOpen && (
    <DesktopForemanColumn
      chat={chat}
      ports={ports}
      live={live}
      messages={messages}
      streaming={streaming}
      agentNameOf={id => agentsById.get(id)?.name ?? 'Coworker'}
      renderBoardOverlay={({ discoveries }) => (
      <DesktopBoardDiscoveries state={discoveries} domain={companyDomain} />
    )}
    />
  )}
</>
```

## Implemented / dependent / unsupported

| Area | Status |
| --- | --- |
| Column/dock/welcome/tabs/composer shell, Escape close, reduced motion | **Implemented** (source) |
| Plan card Confirm / Ask for changes, revision digest identity, retry/lost ACK | **Implemented** (source); **depends** on I decision route |
| Build progress with exact agent/space/session ids; no auto-start all coworkers | **Implemented** (source); **depends** on I build projection |
| Lead setup next step via `start_lead_setup` | **Implemented** (source); **depends** on I build.act + root navigation |
| Discoveries overlay from trusted events; unavailable collectors | **Implemented** (source); **depends** on I discovery subscribe |
| Restart restore of open/tab/draft/pending decision/build via injected persistence | **Implemented** (source); **depends** on root persistence backend |
| Live-only navigation gating | **Implemented** (source); **depends** on root dispatch |
| Full original message widget stack / HITL / intake / arrival / billing | **Unsupported** locally (hosted); root may compose existing desktop chat pieces |
| Hosted signup, marketplace, trial checkout | **Unsupported** |
| Central DesktopApp/Board/Control Center edits | **Root-owned**, not edited |

## Regression sources (authored, unrun)

- `apps/ui/lib/desktop/foreman-client/foreman-client.test.ts`
- `apps/ui/components/desktop/foreman/DesktopForemanUi.test.tsx`

Covered: current vs historical live gating, plan revision decisions, duplicate/pending submit lock,
lost ACK fingerprint retry, stale revision ack, tab change draft preservation, partial build + exact
ids, missing/unavailable discoveries, restart projection.

## Execution note

No checks executed. No push, merge, install, or app exposure. E11 not claimed complete.
