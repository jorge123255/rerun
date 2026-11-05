# Round 29 E4 — local service runtime handoff

Base `447fb9f03cd1113d50d199a1ec4c433198dc0ef9`, branch `desktop/round29-service-runtime`. Source-only work in this lane. Root execution/native acceptance is pending; no capability is marked accepted.

## Original sources and Mac adaptations

Read at original pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` with git show:
- `packages/contracts/src/service.ts`: original service names, statuses, InstallResultView and serviceRegistryKey/parseServiceRegistryKey. This slice uses the original bare-slug base instance key; it does not invent multi-account support. Additional `slug@id` setup remains unavailable under this round's exact request union.
- `apps/ui/lib/services/manifest.ts`, `types.ts`, `instances.ts`: canonical auth methods, input/secret classification, original instance naming.
- `apps/ui/lib/services/compiler.ts:102`: compileService; :147 plaintext engine env updates; :211 decompileService. Local compilation preserves manifest intent but never writes .env, config headers, hosted registry/hub, OAuth tokens or provider credentials into engine files. It deliberately does not overwrite existing same-name skills as original upsertSkill could.
- `apps/ui/app/api/_services/services.service.ts:400` installService; :474 markServiceAuthorized; :505 resetServiceConnection and original actions. The local facade retains details/install/markAuthorized/reset behavior, with actual probe replacing the cloud authorized-state flip.
- Original/current AgentPanelServices, ServiceConfigForm, ServiceFields, AuthMethodPicker and service-setup-driver sources were read for the matching UI/client contract.

Current-base MCP store/lifecycle/remote transport/owner binding/internal route and `apps/engine/src/desktop/mcp-tools.ts` were read. Engine adapter follows that bounded, tagged dynamic-tool pattern. Confined skill-publication and current coworker-skill-store were read. Applicable instructions, `docs/desktop-round29-interfaces.md` and the supplied installed Next route-handler guide were read. No dependencies installed.

## Changed files and exports

- `apps/ui/lib/desktop/server/services/schema.ts`: desktopServicesSchema.
- `apps/ui/lib/desktop/server/services/store.ts`: serviceStore, ServiceStore, ServiceInstall, OwnedSkill; encrypted bearer and sanitized immutable identity/footprint metadata.
- `apps/ui/lib/desktop/server/services/compiler.ts`: compileLocalService, localMethodAvailability, ServicePlan; strict original-method selection, no fallback ID.
- `apps/ui/lib/desktop/server/services/lifecycle.ts`: localServiceLifecycle, LocalServices, ServiceAuthority, ServiceRun, ServiceToolNames; mutations, fresh authority, probe, transport, reconcile, ownedSkills, owner transition, shutdown/drain.
- `apps/ui/lib/desktop/server/services/skill-resources.ts`: createServiceSkill, verifyServiceSkill, removeServiceSkill; shared confined skill publisher with create-only namespaced ownership and identity/version checks.
- `apps/ui/lib/desktop/server/services/api.ts`: serviceMutation, serviceApi; authenticated GET/POST facade.
- `apps/ui/lib/desktop/server/services/bridge.ts`: serviceEngineBridge; authenticated active-run catalog/call/release, opaque capabilities and durable call tombstones.
- `apps/ui/lib/desktop/server/services/binding.ts`: bindLocalServices, localServicesBinding; root-initialized single authoritative binding shared across route bundles.
- `apps/ui/app/api/desktop/coworkers/[agentId]/services/route.ts`: dedicated GET/POST wrapper.
- `apps/ui/app/api/desktop/internal/services/route.ts`: dedicated engine POST wrapper.
- `apps/engine/src/desktop/service-tools.ts`: desktopServiceTools, isDesktopServiceTool; exact local callback, fresh engine services grant, schema bounds, Stop/release and real result delivery.
- `services/compiler.test.ts`, `services/store.test.ts`, `services/lifecycle.test.ts`: authored offline regressions for the actual legacy Microsoft Learn shape, no invented methods, OAuth {}, transport/hosted rejection, Bearer secrecy, owner/revision isolation, receipts/disconnect, permission and restart health.
- This document.

## D/F dependencies and exact surface

D owns `packages/contracts/src/desktop-services.ts` and `server/services/catalog/index.ts`; neither existed in the prepared base at initial inspection, and neither was created/edited here. Root must integrate D before compiling this lane. This source imports D's DesktopServiceHealth / DesktopServiceMethodAvailability through @rerun/contracts (root owns exports), and:

```ts
listDesktopServiceCatalog({query?,category?,offset?,limit?}) // {services: ServiceSearchResultView[], total:number}
getDesktopServiceManifest(slug) // canonical original ServiceManifest | null (sync or async allowed)
getDesktopServiceMethodAvailability(slug,authMethodId) // {id,supported,reason?} (sync or async allowed)
```

The original manifest schema validates D's manifest before use. No synthetic catalog, Supabase search, alternate list or hosted fallback is supplied. Detail responses add methodAvailability, installation and localLimitations to original ServiceDetails, returning only method summaries/inputs, not server templates or credentials. Runtime localMethodAvailability can further refuse a D-supported method that cannot be safely compiled here, with an explicit local reason. All methods stay visible.

F owns the injected ServiceSetupDriver-compatible browser adapter in `apps/ui/lib/desktop/services-client.ts`. API contracts below provide its original details/install/markAuthorized/reset semantics. markAuthorized must probe current revision and return success only for installed+healthy; it must not flip a Boolean or call cloud OAuth. reset performs local disconnect and returns original `{mode:'config',authMethodId}`. There is no additional account allocation, implicit default method or cloud sign-in.

## Supported compilation and ownership

Exactly one canonical HTTPS Streamable HTTP server, anonymous or one exact `Authorization: Bearer ${input.KEY}` binding to one secret input. `oauth` is refused even when `{}`. Stdio/SSE, multiple servers, managed/Composio/app methods, URL substitutions, extra headers/env/commands/args, derived/basic auth and skill interpolation are unavailable. Redundant original env-key mappings for that same Bearer input are recognized without writing any env file; any different environment source refuses. Hosted rerun.build authority and /api/hub/managed proxy paths are refused. Compiler checks are independent of UI/D metadata.

The actual `microsoft` Microsoft Learn seed uses legacy inputs:[]/authMethods:[] and a single HTTP MCP server at `https://learn.microsoft.com/api/mcp`, named `microsoft-learn`. Original normalization calls this method `default`, kind `key` despite no input/header. The compiler treats its actual structure as anonymous. No live Microsoft request was made. Microsoft Learn is root's read-only native candidate, not a verified result of this lane.

Each install has a local owner, pinned engine ID, UUID, schema version, original key/method, immutable compiled non-secret plan, revision, staged state, skill footprint and encrypted bearer. AES-256-GCM uses the existing desktop master-key reader, random IV/tag and owner+installation AAD. Request identity uses a keyed HMAC, not plaintext input or a dictionary-attackable unkeyed credential hash. Receipts hold only safe results/metadata. No secret is stored in .env/config/transcript/receipt/log/error/returned form. Installed/config views expose configured Boolean flags only. The server-only credential accessor exists solely for the existing transport.

MCP resources are installation-owned virtual transport rows, with internal `svc-<installation UUID>` names on the same lifecycle. The public tool prefix remains the original manifest server name. The existing remoteMcpRuntime does the actual initialize/list/call, redirects, Stop, credential validation, output limits and untrusted/isError handling. It reads this service's encrypted authoritative row through a read-only adapter; it does not copy a credential into the custom remote store or create a second token authority. Remote OAuth and arbitrary custom MCP rows are never edited or removed. Root's required assertToolNames callback rejects collisions with built-ins, custom MCP, other services and native tools before healthy/registry publication.

Skills keep original display names/body but use unique installation-owned `svc-<UUID-prefix>-<index>` folders, compiled with the existing confined publisher, no overwrite. Footprints record exact directory identity and manifest version. Removal checks ownership/version and refuses changed/extra-file/replaced folders; same-name custom folders are never adopted or overwritten. No .rerun/services.json ownership fiction is written. Root MUST merge ownedSkills into existing connector/read-only skill ownership and active-skill filtering before activation, as below.

## Health, partial failures and retry/restart semantics

installed:true requires a successful real initialize/list, current enabled/services grant, exact engine/owner identity, verified owned skills, collision checks and the current app launch. The health record includes checkedAt/toolCount. A 60-second freshness window projects older checks as unchecked; saved credentials and catalog verification alone never mean installed/connected. An engine catalog also performs current live discovery under the active run. Disabled/missing permission leaves configured data but installed:false; installing never enables any permission. Disconnect changes revision, invalidates calls and clears local credentials; it does NOT revoke a remote API key. Anonymous disconnected rows also require explicit install again.

Install is staged preparing → ready; failures attempt rollback of only known exact owned skills, clear credentials and retain error/remaining footprint for inspection. A crash after creating a skill but before recording its identity may leave an unconfirmed folder: it is not silently adopted/deleted on retry. Remove stages removing and clears credentials before exact resource deletion; a conflict remains inspectable and does not delete unrelated content. A changed method/skill plan requires explicit remove first. An incomplete install with remaining resources must be resolved/removed before retry. This is not a distributed transaction across SQLite and the filesystem.

Owner-bound request UUID/HMAC claims precede mutation. Complete exact requests replay current safe state only at the same revision; a prior-revision receipt returns unknown/superseded acknowledgement instead of affecting a replacement installation. Claimed/uncertain requests are never blindly relaunched. An active-run call tombstone prevents replay after lost response/restart. Fresh owner, enabled state, active run and grant are revalidated before remote RPCs and final result publication. Stop before a delayed catalog is retained as a terminal run release. Secrets and transport error text never appear in receipt/error output.

At startup, before route/tool admission, reconcile each owner: reset prior health to unchecked; clear credentials and mark error for preparing/removing or mismatched engine identity. Do not replay installs or tool calls. Reconcile preserves exact footprints and request/call tombstones for root inspection. Shutdown closes generation/admission, aborts remote operations, then drains actual in-progress mutation work. Do not race an already-started SQLite/file mutation and claim it failed definitively; stalled storage must remain blocked until root can resolve/terminate the stopped process. The current source supplies no provider revocation or automatic orphan deletion.

## Required typed root integration

No central migrations/bootstrap, grants, registry, navigation, shared exports or packaging were edited. Root must wire all of the following before activation:

```ts
import {desktopServicesSchema} from '@/lib/desktop/server/services/schema'
import {serviceStore} from '@/lib/desktop/server/services/store'
import {localServiceLifecycle,type ServiceAuthority} from '@/lib/desktop/server/services/lifecycle'
import {serviceApi} from '@/lib/desktop/server/services/api'
import {serviceEngineBridge} from '@/lib/desktop/server/services/bridge'
import {bindLocalServices} from '@/lib/desktop/server/services/binding'
// NEW additive numbered central DB migration for existing/new DBs, after desktop_agents:
// await db.executeMultiple(desktopServicesSchema)
const store=serviceStore(db,readExistingDesktopMasterKey)
const authority:ServiceAuthority=async(owner,action,run,signal)=>{
  const current=await resolveExactCurrentServiceOwner(owner,run,signal)
  // REQUIRED root function: current immutable local/engine mapping, not deleting/reassigned,
  // current enabled + saved default-off desktopToolGrants.services.
  // If run supplied, check exact engine/session/run ownership, running state and Stop.
  // For manage, existing disabled/grant-off owners may inspect/configure; use fails closed.
  return {engineAgentId:current.engineId,runtime:current.runtime,skillsRoot:current.canonicalSkillsRoot,
    enabled:current.enabled,granted:current.grants.services===true}
}
const service=localServiceLifecycle(store,authority,async(owner,installationId,names,signal)=>{
  await assertCurrentServiceToolNamesDoNotCollide(owner,installationId,names,signal)
})
const api=serviceApi(store,service)
const bridge=serviceEngineBridge(store,service,authorizeExactServiceRun)
for(const localOwner of currentLocalOwners) await service.reconcile(localOwner,startupSignal)
bindLocalServices({api,bridge}) // ONCE in the supervised UI process, before admitting routes/tools.
```

Root functions above are required contracts, not lane exports. authorizeExactServiceRun(run,signal,action) returns the current local owner, checks active run + services grant for catalog/call, and allows release of the exact historical run after Stop without granting new use. Independent per-request/service copies, independent UI/engine token stores or separate lifecycle authorities are not integration. Hide all desktop_service_* tables from coworker data tools and preserve receipts across restarts. Add D's shared type exports at root integration. The scoped route wrappers are included; central HTTP policy must admit only GET/POST coworker services and POST internal/services, retaining existing origin/session or engine bearer authentication. Do not enable hub publishing, connector installation or arbitrary original /api/hub actions.

Root saved grant defaults off; installing/configuring must not change it. Engine registry/loop integration:

```ts
import {desktopServiceTools,isDesktopServiceTool} from '../desktop/service-tools.js'
const serviceTools=await desktopServiceTools(ctx)
for(const [name,definition] of Object.entries(serviceTools.tools)) {
  if(Object.hasOwn(tools,name))throw new Error('Service tool name collision')
  tools[name]=definition
}
// Add serviceTools.close to closeTools, including Stop/error.
// Add only isDesktopServiceTool(value) to the existing Codex dynamic-tool instance allowlist.
```

Do not allow arbitrary model-supplied tool names/prefixes, raw original hub tools or a forged marker. The engine adapter checks services before catalog and every call, preserves actual untrusted/isError results, and never claims a tool succeeded from registration alone. The server repeats active-run checks on every transport access. Do not enable original publishing tools as a side effect of services.

Root's existing Skills reader/authorizer must merge ownership and visibility:

```ts
const serviceOwned=await service.ownedSkills(localOwner,signal)
const connectorOwners=new Map(serviceOwned.map(resource=>[resource.slug,resource.key]))
// Merge with current original connector ownership. Any owned folder is connector-read-only
// to generic skill editors/tools even while its service is disabled or unhealthy.
// For model skill loading, include owned bodies only while their installation is ready,
// current exact services grant/enabled/owner is valid, and the run is authorized.
```

Do not infer ownership from a name alone or bypass version checks. Store/remove paths remain isolated; no registry file writes are required. Root must wire this before model skill access, not later.

For revoke/disable/delete, root reserves ALL relevant current owner lifecycles across the WHOLE persisted transition. Nest service.transitionOwner with existing remote/OAuth/stdio reservations; inside, bridge.releaseOwner then persist authority. Disconnect alone is insufficient while a grant/deletion write is pending. On Quit close model/HTTP admission, call bridge.shutdown() and await its mutation drain before deleting/closing DB/process resources. A failed drain is not completed cleanup. The singleton cannot be rebound in the same live process; a new app launch creates a new process/binding.

## Limits and root execution

Only base instance, one public/literal HTTPS resource with anonymous or one Bearer input, static bounded skills. No OAuth, device-code, Composio/managed/paid account picker, additional accounts, stdio/SSE, package downloads, env/config writeback or remote key revocation. Existing remote transport's established endpoint policy and exact bearer redaction apply; transformed/encoded secret echoes cannot be generically identified. Root must review endpoint trust and test fixture redaction before credential acceptance. Microsoft Learn read-only acceptance and credential fixtures remain separate claims.

Authored compiler/store/lifecycle regressions were NOT executed. Root must integrate D/F, run tests/type checks/lint/build, check partial install/rollback/orphan handling, unknown receipts/restart, wrong owner/revision, custom collision preservation, skill ownership/edits, secret redaction, Stop/revoke/delete/Quit at every await and actual same-run tool result use. Only root may make the live Microsoft Learn probe or supply disposable credential fixtures/user credentials.

**No tests, type checks, lint, builds, packaging, installs, app control, live workspace/Keychain access, credentials, service/model/network requests or Mac/restart checks were run by me. Root execution/native acceptance is pending.** No other lane, central checklist, shared catalog or contract files were edited. No push or merge.
