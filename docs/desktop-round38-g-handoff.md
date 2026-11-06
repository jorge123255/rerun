# Round38 G — API connection Settings UI

Implementation commit: `25222984a8d5d4c8395c10ec8b8bb42c569bf1a7`.

Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round38-g-api-connections-ui`; branch `desktop/round38-g-api-connections-ui`. Initial branch, HEAD `6f6ad959a09abaf1947950b6f82413c94407e22a` and clean status were inspected before editing. This handoff is a separate commit after the source commit; its final tip is reported in the delivery message.

**No checks executed and no installed acceptance.** Tests/regressions, typecheck, lint, build, formatters, installations, servers, provider/API/network requests, browser/native UI, accounts, microphone, Keychain, live credentials/databases and restart checks were not executed or accessed. Only source/Git inspection, owned edits and local commits. Commit hooks were disabled to honor the no-execution rule. No push, merge, publication, grants or provider connection was performed. Root owns review, repairs, every execution check, route/Settings composition, packaging and installed acceptance.

## Exact F dependency — read only, never copied

F worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round38-f-api-connections`.

- Published handoff tip, inspected clean: **`72e8ef863fa353897115f46d363b7020e0282f63`**.
- Runtime implementation: `1680a0c683c27866f2d86b7a14a0a435409e8448`.
- Default-reference compatibility: `04d575dad34f273252eb7c18494e167dac7f1206`.
- Initial contract publication: `764a9a44b4436ee8fd43c9e022c797fdf513996e`.
- Sole contract: `packages/contracts/src/desktop-api-connections.ts`, version1, blob **`254be83e555e0653973a885724968b52e55b5364`** at F's handoff tip.
- Handoff: `docs/desktop-round38-f-handoff.md` at that same tip.

G imports F's canonical types and runtime schemas from `@rerun/contracts`. F's file is intentionally absent from G's prepared base; root must compose F and add its barrel export before compilation/activation. No contract file, schema substitute, F code or dependency commit was copied or cherry-picked into this lane. F's tree was only read and remained clean at the last inspection. No changes to RD37 custom-provider/OpenCode UI, subscriptions, F runtime/contract, central Settings/routes, lockfiles or any other lane.

## Original-source audit and design mapping

Read actual original Git objects at comparison pin **`2a57fa6dd53311f763bfc9abde85997b7f7e5309`**, retaining historical design/acceptance pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. No EE modules, hosted actions or latest branch were adopted.

| Original source | Reused behavior and Mac adaptation |
| --- | --- |
| `apps/ui/components/connections/AiProvidersPanel.tsx` | List → provider add/detail through the existing `PanelSteps`, grouped “Default model” / “Your API keys”, named source rows, Add API key menu, empty pitch and skeleton/loading/error states. Current original `ProviderPicker` still offers already-added providers; no provider-level deduplication. G handles only F's four API providers alongside root's unchanged subscription/custom/OpenCode flows. |
| `apps/ui/components/connections/AddProviderPage.tsx` | Same `ProviderHeader`, Name, API key, credential guide and Add key order/copy. Original suggested naming distinguishes another account for the same provider. F create input replaces hosted `{keys}` actions. Cancel/Back preserve the same workspace's in-memory draft. No auto-default claim: G displays only F's returned saved default. |
| `apps/ui/components/connections/ConnectionDetail.tsx` | Header rename, rejected/missing-key explanation, model curation, custom model IDs for OpenRouter and destructive footer. Existing `ModelBuckets`, keyboard DnD/move controls and original model/default locks are reused via a redacted shape adapter. Replacement form remains available for a saved key as requested; it never reads the old key. |
| `apps/ui/components/connections/DeleteConnectionButton.tsx` | Removal only in detail; usage read before confirmation, original Remove/Cancel wording and local errors. Replaced hosted usage action with F's complete removal plan. F usage names/IDs, schedules/triggers, workspace-default clearing, pending runs and preserved sibling IDs are shown. G re-reads before mutation and requires another confirmation if the plan changed. No assertion of a hosted Rerun fallback on Mac. |
| `SourceBits.tsx`, `DetailBlock.tsx`, `ProviderPicker.tsx`, `ModelBuckets.tsx`, `CustomModelList.tsx`, `DefaultModelPicker.tsx` | Reuse original headers/avatar, sections, provider picker and real model buckets. Custom-ID input mirrors the existing layout but retains its text until ACK rather than clearing it immediately. Default selection keeps the current Mac native grouped select, avoiding invented billing/credit state required by the hosted default picker. Status says **Key saved**, not Ready/probe passed. |

Current Mac audit: `DesktopSettings.tsx` finds a fallback connection by provider and offers only providers not already present; that is unsuitable for siblings. G never uses that fallback. Existing Settings API, desktop auth/http wrapper, engine connection routes/client and canonical connection/usage/model contracts were read. G does not mount original `ConnectionDetail`/`AddProviderPage` wholesale because they invoke hosted actions, OAuth children or billing paths.

Instructions read: applicable AGENTS/CLAUDE files, `docs/desktop-agent-assignment-standard.md`, updated-source review notes and installed Next client-boundary guide at `final-build/apps/ui/node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md`. All callback props remain between client components. No dependency installation.

## Changed files (14 source files plus this document)

- `apps/ui/components/desktop/connections/api/ApiConnectionsPanel.tsx`
- `apps/ui/components/desktop/connections/api/ApiConnectionBits.tsx`
- `apps/ui/components/desktop/connections/api/ApiAddProviderPage.tsx`
- `apps/ui/components/desktop/connections/api/ApiConnectionDetail.tsx`
- `apps/ui/components/desktop/connections/api/ApiDeleteConnectionButton.tsx`
- `apps/ui/components/desktop/connections/api/ApiConnections.test.tsx`
- `apps/ui/lib/desktop/api-connections/client.ts`
- `apps/ui/lib/desktop/api-connections/session.ts`
- `apps/ui/lib/desktop/api-connections/presentation.ts`
- `apps/ui/lib/desktop/api-connections/fixtures.ts`
- `apps/ui/lib/desktop/api-connections/server.ts`
- `apps/ui/lib/desktop/api-connections/server.test.ts`
- `apps/ui/lib/desktop/api-connections/client.test.ts`
- `apps/ui/lib/desktop/api-connections/session.test.ts`
- `docs/desktop-round38-g-handoff.md`

## Concrete exported boundaries

`createApiConnectionsClient(routes, transport = fetch): ApiConnectionsApi` is a real HTTP adapter, not a success mock. `ApiConnectionsApi` exposes only F's operations and exact F inputs/results: list, removalPlan, create, rename, models, credential, select and remove. `ApiConnectionOperation` is a discriminated TypeScript union over F's existing input types; there is no new protocol schema. Every input/result is validated with F's schema. Body/receipt workspace, request, kind and target identities are checked. GETs carry no key; writes use POST JSON. Paths must remain same-origin `/api/desktop/`, with no credentials, query or fragment; redirects fail, credentials use same-origin, responses are uncached, bounded to 2MiB and time out after 20 seconds. Errors never echo a raw server body, secret-bearing input or validation data.

Routes are injected because F published service methods, not an HTTP route agreement. Root owns the URLs and can map the three callbacks below to its chosen authenticated paths without changing DTOs:

```ts
type ApiConnectionRoutes = {
  catalog(workspaceId: DesktopWorkspaceId): string
  removalPlan(workspaceId: DesktopWorkspaceId, connectionId: string): string
  mutation(workspaceId: DesktopWorkspaceId, kind: DesktopApiMutationKind): string
}
```

`ApiConnectionsSession` is the per-panel renderer controller. It uses exact ID/revision lookups, serializes a human mutation, retains its immutable input/request ID while uncertain, validates actual receipts, rejects stale workspace/page/revision results and publishes only redacted DTOs/status. It does not optimistically overwrite a catalog. A refused receipt reopens editing; uncertain/network failure blocks new writes and offers explicit Retry same request. Read generations and write generations prevent late callbacks from replacing a resumed view. Removal review validates exact connection/revision, run owners and sibling exclusion, then re-reads and compares F's canonical JSON before sending remove.

Private drafts are scoped by workspace session and connection/provider form keys. Typed keys remain only in private renderer memory/password inputs and outgoing canonical secret writes. `snapshot()` contains no drafts/secret. There is no localStorage/sessionStorage/IndexedDB, log, transcript, browser credential store or second backend custody. Accepted secret mutations clear the matching draft; Cancel/Back and soft suspension keep it. Dirty drafts retain their original expectedRevision; a changed connection cannot silently rebind them. Explicit “Use the current connection revision” preserves a typed replacement after the user reviews a revision change. Actual disposal/workspace change erases private drafts and aborts owned waits.

```ts
type ApiConnectionsPanelProps = {
  workspaceId: DesktopWorkspaceId
  currentWorkspace(): DesktopWorkspaceId | null
  active: boolean
  api: ApiConnectionsApi | null
  selectionContext: Pick<DesktopApiSelectInput, 'source' | 'runId' | 'sessionId'> | null
  onCatalog?(catalog: DesktopApiConnectionCatalog): void
}
```

`api:null` is an explicit unavailable state with no operational fields/requests. `selectionContext:null` leaves real model/default data readable but disables selection. The context must come from the current root authority matching F's exact selection contract; G does not manufacture run/session IDs or reinterpret those fields. Current Settings selection should use root's legitimate workspace selection context. Other source kinds remain root's separate caller concern.

`apiConnectionSummary` maps the exact redacted F view to the existing `ConnectionSummary` required by ModelBuckets. `apiCredentialStatus` deliberately distinguishes presence/rejection from a probe. `removalConsequences` consumes F's actual usage model. `apiEndpointDisplay` shows origin only and strips URL userinfo/query/fragment/path from display; endpoint editing is unavailable because F's mutation interface has no endpoint patch. RD37 custom endpoint/OpenCode UI is left untouched.

## Root composition order and exact fragments (not applied)

### 1. Compose F's committed contract/runtime first

Integrate F at `72e8ef863fa353897115f46d363b7020e0282f63`, including its canonical encrypted custody/runtime, revision/request-receipt migration, exact run-drain authority and export:

```ts
// packages/contracts/src/index.ts — root-owned
export * from './desktop-api-connections.js'
```

Use F's handoff for runtime initialization and the next free migration. No migration is added by G. F owns legacy API connection adoption/ID/revision compatibility. Do not synthesize new IDs in the renderer, replace siblings or discard existing subscription defaults to satisfy a schema. Missing migration/runtime/drain authority must remain unavailable.

### 2. Root authenticated engine registration

Register new desktop API-connection methods against F's **already initialized** `createDesktopApiConnectionRuntime` instance in the workspace's authenticated engine. Do not route these operations through the original generic `/connections` create path, whose `announceConnected` calls a hosted notification path. Do not instantiate F in the renderer or point UI at the engine port/API key.

The root engine route can switch over the F kind, parsing with F's exact input schema before calling the matching method. List calls `connections.list()` (actual service signature has no argument); validate the requested workspace against the runtime before the call. Removal review calls `connections.removalPlan(workspaceId, connectionId)`. Mutations call the same-named service method with parsed input and request cancellation signal. Return direct validated F DTOs, not a fabricated `{success:true}` wrapper. Preserve F's saved/refused/uncertain result and same-request receipts.

Root owns engine authentication, provider/catalog policy and route allowlists. Registration must be local workspace-bound and must retain F's exact captured credential/run behavior. No grant or provider account is enabled by this UI source.

### 3. Root loopback route map and proxy

One additive route map (proposal for root composition; no route is installed by G):

| Local UI route | Method | F operation |
| --- | --- | --- |
| `/api/desktop/workspaces/[workspaceId]/api-connections` | GET | list |
| `/api/desktop/workspaces/[workspaceId]/api-connections/[connectionId]/removal-plan` | GET | removalPlan |
| `/api/desktop/workspaces/[workspaceId]/api-connections/mutations/[kind]` | POST | exact kind |

`server.ts` supplies the concrete `createApiConnectionsEngineProxy` and `createApiConnectionsRouteHandlers` bindings. The proxy uses the existing authenticated `lib/engine/client.ts:request`, keeping the engine bearer credential server-side, with redirects refused and a 20-second cancellation/deadline. Handlers use the existing `desktopRoute` authentication, exact path/body workspace checks, 256KiB `readDesktopJson`, F input/output schemas and canonical request acknowledgement checks. They authenticate again before effects and after engine awaits, comparing workspace, launch nonce, build and engine origin. A workspace change after commitment refuses stale publication while leaving F's receipt intact. No new route is mounted until root installs these handlers.

Root can bind the engine paths consistently with the registration above:

```ts
// Root server composition module, imported by the three route files:
export const apiConnectionHandlers = createApiConnectionsRouteHandlers({
  catalog: () => '/desktop/api-connections',
  removalPlan: (_workspaceId, connectionId) => `/desktop/api-connections/${encodeURIComponent(connectionId)}/removal-plan`,
  mutation: (_workspaceId, kind) => `/desktop/api-connections/mutations/${kind}`,
})
```

This default deliberately refuses selection with 503 until root supplies the real `authorizeSelection(runtime, input, signal)` callback as the factory's second argument. That callback must validate F's source/run/session context against current authority, not just return successfully. Until it is connected, pass selectionContext:null to the UI as well. Every other handler is concrete and forwards only to the registered F service. No placeholder success is returned.

Exact Next route wrappers (separate root-owned files, with the shared handler imported):

```ts
// .../api-connections/route.ts
export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  return apiConnectionHandlers.catalog(request, (await context.params).workspaceId)
}
```

```ts
// .../api-connections/[connectionId]/removal-plan/route.ts
export async function GET(request: Request, context: { params: Promise<{ workspaceId: string; connectionId: string }> }) {
  const params = await context.params
  return apiConnectionHandlers.removalPlan(request, params.workspaceId, params.connectionId)
}
```

```ts
// .../api-connections/mutations/[kind]/route.ts
export async function POST(request: Request, context: { params: Promise<{ workspaceId: string; kind: string }> }) {
  const params = await context.params
  return apiConnectionHandlers.mutation(request, params.workspaceId, params.kind)
}
```

Root still owns engine-side registration of these F service paths, route allowlists and initialization. The owned proxy does not call generic hosted connection actions or bypass runtime credentials. Until those real routes/runtime are available, pass api:null. Authority/network waits remain outside write transactions. Client cancellation is never treated as reversal of a committed effect.

Client construction against that map is concrete:

```ts
const api = useMemo(() => createApiConnectionsClient({
  catalog: workspaceId => `/api/desktop/workspaces/${workspaceId}/api-connections`,
  removalPlan: (workspaceId, connectionId) => `/api/desktop/workspaces/${workspaceId}/api-connections/${encodeURIComponent(connectionId)}/removal-plan`,
  mutation: (workspaceId, kind) => `/api/desktop/workspaces/${workspaceId}/api-connections/mutations/${kind}`,
}), [])
```

### 4. Root Settings mount and partial-catalog reconciliation

Mount inside the existing AI providers Settings navigation, replacing only the old standard API-key subflow. Keep subscription, RD37 custom-provider and OpenCode paths in their current owners. Do not mount the original hosted AiProvidersPanel. Preserve root's board/tab visibility and Settings container navigation. Give the panel a constrained flex/scroll parent:

```tsx
<div className="flex min-h-0 min-w-0 flex-1 flex-col">
  <ApiConnectionsPanel workspaceId={runtimeWorkspaceId}
    currentWorkspace={() => currentRuntimeRef.current?.workspaceId ?? null}
    active={settingsOpen && settingsSection === 'AI providers'}
    api={apiConnectionsRuntimeReady ? api : null}
    selectionContext={currentApiSelectionContext}
    onCatalog={catalog => {
      if (currentRuntimeRef.current?.workspaceId !== catalog.workspaceId) return
      // In the root's existing state updater, merge by exact connection id:
      setProviders(previous => ({
        connections: [
          ...previous.connections.filter(c => !DESKTOP_API_CONNECTION_PROVIDERS.some(provider => provider === c.provider)),
          ...catalog.connections.map(apiConnectionSummary),
        ],
        default: catalog.default,
      }))
    }} />
</div>
```

The partial-catalog merge preserves subscriptions/custom/OpenCode and all F-returned API siblings. It does not map by provider or replace the entire ConnectionsList with an API-only list. Current defaults referencing Codex/Claude remain valid in F's compatible default-reference type; the UI leaves them intact when merely loading. `onCatalog` is observational state synchronization from real server data, never an implicit selection. Root must retain its ordinary authenticated refresh/conflict handling when another Settings owner changes a catalog concurrently.

Keep this component mounted for the same workspace during **soft** Settings close/section cancellation and pass active=false, rather than destroying its controller. It suspends exact requests and preserves form drafts without auto-writing. Reopening performs only a catalog read. Workspace change or genuine owner disposal closes the controller and clears its private typed keys. Do not recreate `api` every render; a different API object is a different lifetime and intentionally disposes the old controller.

Root must not leave the old provider-level `find(c => c.provider === provider)` API edit branch mounted for these same flows. Current original ProviderPicker supports duplicates; this panel selects/detail-edits/removes by exact ID/revision throughout. For root deep links, the exported `ApiConnectionsPage` and controller `navigate` represent list/add/detail; root owns connecting those to its existing Settings router. No competing global router was added.

### 5. Lifecycle/recovery gates that remain root/F dependencies

F has durable configuration, revisions and request receipts. G retains an uncertain input/request only in the current workspace controller and never automatically repeats it. Root shutdown must suspend admissions and retain canonical unresolved receipts; a renderer abort is not a successful cancellation. Already accepted effects survive close/Stop.

**Concrete missing restart interface:** F's published service/API surface has no public receipt discovery/read/recovery operation. G therefore cannot restore an uncertain operation's request after full process disposal without inventing a protocol or persisting credentials outside canonical custody. Root must expose recovery using F's existing receipt authority (and an explicit re-entry path for secret-bearing intent if required), reconcile pending operations and gate fresh mutations before claiming full-restart uncertain-write recovery. A public receipt by itself does not authorize reconstructing/replaying a secret input. G adds no substitute receipt schema or browser secret persistence. Root should withhold mutation activation if its acceptance scope requires that missing recovery boundary. Saved configuration still reloads normally from F; no create/probe/write is performed on restore.

**Removal concurrency limit:** G obtains F's full plan on human open and again on confirm. Any changed plan is shown and requires another human confirmation; false canRemove blocks removal. F rechecks/drains before release. Its remove input contains only request/workspace/connection/expectedRevision, not a reviewed usage token. Root/F must serialize consequence changes across the final review/release if exact displayed-usage binding under concurrent default/automation edits is required. G cannot add a competing plan token to F's strict contract. The plan's usage identifies agents, automation kind/slug/owner and whether the workspace default is cleared; it does not expose every saved reference's model value. G displays the actual available consequence model without inventing absent detail.

## Implemented / dependent / unsupported

| Area | Owned source | Dependency/limit |
| --- | --- | --- |
| Distinct sibling list/add/detail/rename/remove/select | Implemented with exact IDs and expected revisions | F runtime, root routes and Settings mount |
| Name/key validation and original key-entry guide | F schema-derived bounds; no guessed key-format acceptance | Saving is not probing; real provider rejection remains F state |
| Masked replacement and cancelled drafts | Private same-workspace controller; no saved key read | Genuine disposal erases typed keys; no browser secret persistence |
| Models/default selection | Actual original ModelBuckets, curated/retained IDs, exact sibling selector | Requires root's real F selection context; null disables select |
| Removal warnings | Actual F agents/automations/default/runs/siblings, refreshed before remove | F drain authority; concurrent reviewed-usage binding as noted |
| Lost acknowledgement within mounted lifetime | Same immutable request retry, no new ID while uncertain | Canonical F receipt reconciliation |
| Full-restart uncertain-write recovery | Not fabricated or auto-replayed | Missing public F/root recovery discovery boundary |
| Base URL edit, subscription/OAuth/custom/OpenCode | Not changed | F has no endpoint patch; existing owners remain authoritative |
| Probe/provider calls, billing, automatic permissions | Not implemented or claimed | Explicitly outside this source task |
| Installed/native acceptance | Not run | Root review, all checks, packaging and restart QA |

## Authored regression sources — unrun

- `session.test.ts`: two same-provider siblings selected by exact ID/revision; external existing default preserved; wrong-connection forms refused; stale workspace reads ignored; Cancel/suspend draft retention; same-request retry after lost ACK; no key in public state; dirty revision rejection and explicit revision review; changed removal consequences require reconfirmation; pending runs/drain refusal; late mutation generation after suspension cannot publish over recovery.
- `client.test.ts`: exact secret POST DTO, no query/path secret, redirect refusal, strict rejection of secret-bearing returned views, foreign acknowledgements, foreign origins, generic error bodies and already-cancelled requests. All transports are authored offline fixtures, not live calls.
- `server.test.ts`: offline authenticated bridge/engine fixtures cover exact credential DTO forwarding, redirect refusal, no public secret, post-commit workspace-change refusal and selection unavailable without root authority.
- `ApiConnections.test.tsx`: real panel/add/detail with actual shared controls; sibling selection, masked add field, Cancel creates nothing and retains draft, no stored secret display, actual removal warning identities and Cancel no-op, explicit unavailable service/selection context. No provider/UI/fixture execution by G.

## Remaining acceptance evidence

Root must execute type/tests/lint/build, verify F's barrel/migration/runtime/proxy composition, key custody and error redaction, selection context semantics, sibling-safe catalog integration, keyboard/focus and narrow/short layout, removal/Stop/concurrent usage races and full-restart recovery. Source uses original constrained scrollers/steps, wrapping footer/forms, min-width/truncated names and the existing accessible Radix alert dialog. No screenshot or runtime behavior is claimed as verified.
