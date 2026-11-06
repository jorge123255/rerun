# Round 33 — Agent I handoff: local Foreman runtime (E11 runtime)

Worktree `round33-foreman-runtime`, branch `desktop/round33-foreman-runtime`, base `56fdce61a780e005644057cc77d8edebbf0d067a` (verified clean before edits). Original pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

**Source only. No tests, type checks, lint, builds, installs, servers, live providers or Mac/restart checks were run. Not accepted; E11 is not marked.** Root runs every check and fixes defects directly.

## Commits
1. `a5e3842` — canonical contract delivered early for H.
2. Final commit (this doc) — runtime, adapters, regressions. Contract change after (1), **additive only**: `foremanRevisionSchema.model` (local connection id + model name, no secret) and `foremanDecisionSchema.feedback`. H's handoff already records both. Contract version stays 1.

## Files
- `packages/contracts/src/desktop-foreman.ts` — canonical contract (no tests inside contracts `src`).
- `apps/ui/lib/desktop/server/foreman/{authority,store,seal,runtime,server}.ts` — runtime, durable store over root's DB, handlers.
- `apps/ui/lib/desktop/server/foreman/{runtime.test.ts,runtime.test-support.ts}` — regressions + test-only store/authority doubles.
- `apps/engine/src/desktop/foreman/{tools,discovery,prompts,index}.ts` — engine tools, bounded discovery, phase briefs.
- `apps/engine/src/desktop/foreman/{tools,discovery,contract}.test.ts` — regressions.

## Original mapping (pin a6d63a4)
| Original | Local |
| --- | --- |
| `lib/foreman/phase.ts` foremanPhase, ForemanPlanItem/Box | contract phases (`discover/plan/build/companion`; hosted waitlist/trial dropped), plan item/box schemas; phase derivation in `runtime.readView` |
| `lib/foreman/tool-defs.ts` showPlanDef/planItemsSchema/PLAN_BOXES_SCHEMA | `foremanShowPlanInputSchema` (title/boxes/items, beats, gets ≤3, when, need, box); `tools.ts` SHOW_PLAN_DESCRIPTION |
| `lib/foreman/plan-items.ts` readPlanItems/readPlanBoxes refusals | schema superRefine (no template+coworker mix, Box ≤5, unknown Box refused) + `seal.ts` |
| `lib/foreman/shown-plan.ts` lastShownPlan/planRevisionAsk | immutable sealed revisions (latest wins, prior `superseded`); feedback of every ask_changes on the plan carried (≤4000 chars) into SOUL/install |
| `lib/foreman/build-team.ts` buildTeam/boxNamesOf/onboardingSoul/onboardingInstall | `runtime.construct` (Boxes in card order, then items; first item is lead; none started), `seal.ts` firstSoul/firstInstall |
| `lib/foreman/setup-handoff.ts` startAgentSetup | `start_lead_setup` action, lead only, explicit, idempotent per requestId |
| `lib/foreman/phases/{plan,build,discover}.ts` | `prompts.ts` foremanPhaseInstructions; build has no brief (app-driven) |
| `lib/foreman/scripted.ts` (app writes plan on confirm, builds without a model) | `decide(confirm)` reserves the build in the same transaction, then `runBuild` |
| `lib/foreman/tools.ts`, `engine/src/tools/builtin/foreman.ts` intentTool transient FOREMAN_INTENT_PART | `open_panel` → `emitNavigation`: live+observed only, publish-only, never stored |
| `lib/company/explore/findings.ts` DiscoveryEvent/applyToRow/labels | `foremanDiscoveryEventSchema` (+`unavailable`), `applyForemanDiscoveryEvent`, `DESKTOP_FOREMAN_SOURCE_LABELS` |
| `state.ts`, `plan-scene.ts`, `engine-brief.ts` | state is derived from durable rows; plan-scene is H presentation; engine brief = `foremanTools`+`prompts` |

Local adaptations: items are built sequentially (original parallel) so every effect has an ordered durable receipt; up to 8 items (original onboarding cap 1; desktop is a team builder); `template` items use local template ids; `share` items unsupported.

## Canonical exports (`@rerun/contracts` once root re-exports)
`DESKTOP_FOREMAN_CONTRACT_VERSION`, `DESKTOP_FOREMAN_LIMITS`, `DESKTOP_FOREMAN_PHASES`, id schemas (`fmc_/fmp_/fmr_/fmd_/fmb_/fmx_`), `foremanBindingSchema`, `foremanChatRefSchema`, `foremanModelRefSchema`, `foremanShowPlanInputSchema`, `foremanSealedPlanSchema`, `foremanRevisionSchema`, `foremanDecisionInputSchema`, `foremanDecisionSchema`, `foremanBuildSchema`, `foremanBuildItemSchema`, `foremanBuildActionSchema` (`stop`/`resume`/`start_lead_setup`), `foremanDiscoveryEventSchema`, `foremanDiscoveryRunSchema`, `foremanFindingSchema`, `foremanNavigationIntentSchema`, `foremanLiveEventSchema`, `foremanConversationViewSchema`, `foremanErrorSchema`, `applyForemanDiscoveryEvent`, `DESKTOP_FOREMAN_SOURCE_LABELS`, plus `Desktop*` types.

Server (`apps/ui/lib/desktop/server/foreman/server.ts`): `openForemanRuntime`, `foremanHandlers`, `DESKTOP_FOREMAN_SCHEMA_STATEMENTS`, `ForemanRefusal`, `ForemanError`, types. Engine (`apps/engine/src/desktop/foreman/index.ts`): `foremanTools`, `FOREMAN_FORBIDDEN_TOOL_NAMES`, `foremanPhaseInstructions`, `collectForemanDiscovery`, `webFetchPageReader`.

## Root wiring
1. `packages/contracts/src/index.ts`: `export * from './desktop-foreman.js'`.
2. Schema: append `DESKTOP_FOREMAN_SCHEMA_STATEMENTS` as a new numbered desktop DB step (tables `desktop_foreman_{revisions,decisions,builds,actions,discoveries}`); add a step test from the previous version. The runtime never creates tables.
3. Startup: `const foreman = openForemanRuntime(db, authorities, companyName); await foreman.reconcile()` before mounting routes.
4. Routes (Next modules export only handlers; binders stay server-side):
```ts
const h = foremanHandlers(foreman)
// GET  /api/desktop/foreman/view?workspaceId&chatId -> h.view
// POST /api/desktop/foreman/decision                -> h.decide
// POST /api/desktop/foreman/decision/recover        -> h.recoverDecision
// POST /api/desktop/foreman/build                   -> h.buildAction
// engine callback channel only: h.engineShowPlan / h.engineNavigate / h.engineDiscover
```
5. Engine: in the Foreman run's tool assembly, `foremanTools({ binding, reportShownPlan, navigate, discover })` where `binding` is the exact `{workspaceId, chatId, runId, model}` the run was admitted on (null ⇒ no tools) and the three ports post to the authenticated engine-callback channel. Prepend `foremanPhaseInstructions(view.phase, …)` to the system brief.
6. Authorities (`authority.ts`, all required; missing ⇒ 503 `authority_missing`):
   - `run.isLive / currentLive (read-only) / isObserved / sendFollowUp (idempotent per requestId on chat's selected model) / lookupFollowUp / modelAvailable` — bind to accepted chat-model (`resolveDesktopChatModel` read path only), run admission and stop-turn state.
   - `workspace.currentWorkspaceId / agentCount`.
   - `creation.ensureBox/lookupBox` — **missing root operation**: request-id-keyed Box creation receipt (spaces.ts has placement but no request receipt). `createCoworker/lookupCoworker` — **missing root operation**: the accepted `/desktop/agents/create` refuses SOUL/setup text, so root must add a trusted Foreman creation path keyed by requestId that writes first SOUL + install, `setup.required=true`, no kickoff run, default conservative grants, exact Box placement; `lookupCoworker` returns `replaced` when the place is held by another coworker. `installTemplate/lookupTemplateInstall` — bind to accepted template install intents/receipts.
   - `setup.startSetup/lookupSetup` — bind to `mutateDesktopSetup(runtime, agentId, { action: 'start', requestId, expectedRevision })`.
   - `events.publish` — live channel to the observing renderer only (not persisted).
   - `collectDiscovery` — `({url, signal, emit}) => collectForemanDiscovery({ url, signal, emit, read: webFetchPageReader(executeWebFetch, { coworkerId, assertPermission }) })`, or `null` (every source then reports `unavailable`). Root decides the permission identity for the Foreman.
   - Throw `ForemanRefusal` only for definitive non-effects; any other throw is treated as an unknown acknowledgement.

## Behaviour
- **Plan**: show_plan only from the exact live binding; validated, sealed with stable `item-N/box-N` keys and SHA-256 digest; replay of the same tool call idempotent, changed replay refused.
- **Decisions**: user route only, exact chat/plan/revision/digest of the latest still-shown card; one decision per revision (DB unique); replay by requestId idempotent, reused id with other content refused; pending/uncertain decision or unsettled build blocks contradictory decisions. No model tool can confirm (`FOREMAN_FORBIDDEN_TOOL_NAMES`).
- **Ask for changes**: exactly one follow-up per requestId; lost ack ⇒ `uncertain`, settled by `recoverDecision`/startup from the receipt (resent only when the receipt is definitively absent).
- **Build**: reserved with per-Box/per-item request ids in the confirm transaction, before any effect; CAS-versioned progress events; Stop settles unstarted items, never deletes; Resume retries with the same identities after receipt reconciliation; workspace change / missing model fail closed before effects.
- **Restart**: `reconcile()` reads exact receipts; interrupted builds become `stopped` (Resume is explicit); unknown stays `uncertain`; replaced/deleted are reported and untouched; running discoveries become `stopped`, never rerun.
- **History**: `readView` is read-only; `live=null` for saved runs; navigation/discovery require live (+observed for navigation); navigation targets must be this chat's build results.

## Regression sources (authored, UNRUN)
- `apps/ui/lib/desktop/server/foreman/runtime.test.ts`: plan validation; live-only show_plan; replay/changed replay; supersede/stale; forged digest/other chat; no model confirm; simultaneous decisions; duplicate confirm; ask-changes once + feedback in SOUL; lost follow-up ACK blocks + recovery; ordered build/no start/lead; partial + same-identity resume; lost creation ACK reconcile; Stop; missing model; workspace change; restart reconcile without effects; replaced coworker; lead-only setup once; read-only history; live/observed/owned navigation; unavailable discovery; no discovery rerun + restart stop; copy isolation.
- `apps/engine/src/desktop/foreman/tools.test.ts`, `discovery.test.ts`, `contract.test.ts`.

## Matrix
| Capability | Status |
| --- | --- |
| Contract, validation, sealed revisions, decisions, build/receipt state machine, reconciliation, live-only navigation, discovery reducer + site collector, engine tools, phase briefs | Implemented (source, unrun) |
| Foreman creation op with SOUL/install/no kickoff; request-keyed Box receipt; run/observer/model/follow-up authorities; contracts re-export; DB step; route mounts; engine callback; event channel; Foreman web_fetch permission identity | Dependent on root |
| Hosted waitlist/trial/checkout, share links, template library cards, search/LinkedIn/registry/Google/DNS/stack collectors, logos, auto-start of all coworkers, schedules from plans | Unsupported (honestly reported) |

## Limitations
- Lock against concurrent `runBuild` is in-process; cross-process safety relies on CAS + request-id receipts.
- `webFetchPageReader` assumes `executeWebFetch(raw:true)` returns the body in `text`; root verifies.
- Discovery is a single home-page read (identity only); other finding kinds exist in the contract but are not produced locally.
