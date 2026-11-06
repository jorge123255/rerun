# Round 36 G — remote-machine client pairing and lifecycle adapters

**Source commit:** `8e05c34b35da9c66927bb15f291b43838a8058e2` (16 source/regression files).

**Branch/worktree:** `desktop/round36-remote-machine-runtime`, `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round36-remote-machine-runtime`.

**Exact parent/base:** `970415507e28824bb001f46c8537d20fd2636b1c`. Branch, HEAD and clean status were verified before editing. The source commit's parent matches that base, and its worktree status was clean immediately after committing. This document is a following documentation-only commit so it can cite the full source SHA without a self-referential hash. Its commit SHA and final status are reported with delivery; root needs both commits.

**Scope:** W1 remote-client portion, source only. No tests, type checks, lint, builds, dependency installation, servers, network/provider calls, Docker, browser/native UI, microphone, Keychain or restart checks were executed. No remote machine was paired, no live workspace/credential/database was read, and no installed app was touched. No push, merge, publication or acceptance claim. Root integrates, executes checks, repairs findings and obtains owner approval before real remote pairing/QA. Round35's source integration is a dependency reference, not accepted installed functionality.

## Original source/design mapping

Read actual original objects at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

| Original | Meaning preserved / necessary Mac adaptation |
| --- | --- |
| `apps/ui/components/dialogs/ServersDialog.tsx` | Original `Servers`, one server per workspace, `Enter a server by hand`, Address then password API key, Back/Connect, Connected/Unreachable metadata, Remove confirmation/copy, wrapping footer and scrolling dialog. H owns the presentation; G exports the copy/contract, not a replacement dialog. |
| `apps/ui/components/layout/WorkspaceSwitcher.tsx` | Traced actual Servers dialog caller and hosted `SERVERS_ENABLED` gate. Root/H mount the local adapter in their existing workspace surface instead of importing hosted server actions. |
| `apps/ui/app/api/_actions/servers.actions.ts` | Original workspace ownership, explicit manual attach/detach, bounded public error/result shape. Replace hosted action ownership with canonical local install/workspace/window identity. |
| `apps/ui/app/api/_services/servers.service.ts` | Original `/health` reachability then authenticated `/connections` key proof, one attached machine per workspace, safe detach that preserves remote data. The port keeps those read-only proof requests, adds authenticated stable identity and HTTPS pinning, and separates saved pairing from runtime activation receipts. |
| `apps/ui/app/api/_services/workspace-engine.service.ts` | `findWorkspaceEngine` scopes the engine to a workspace; `attachCustomEngine` does not power/manage somebody else's server. No hosted `engine_pool`, cloud credentials or automatic engine allocation is inherited. |

The original Docker/pairing-token command, 15-minute hosted token exchange and 3-second dialog health polling are not ported. This slice exposes **manual address/key only** and explicit health checks. Opening/reconciling reads cached state; it never connects. HTTPS-only origins replace the original HTTP example. Unverifiable legacy hosts fail explicitly rather than being adopted by hostname. Original labels/layout stay with H, including:

- Title `Servers`; description `The machine your coworkers run on. One per workspace.`
- Manual title `Enter a server by hand`, fields `Address`, `API key`, action `Connect`.
- Title `Remove this server?`; action `Remove`.
- Description `Your coworkers stop answering until a server is attached again. Everything they know stays on the machine: attach it again to get them back.`

Read applicable CLAUDE/AGENTS, the assignment standard at this base and its updated Round35 integration lessons. Installed Next.js `use-client` and route-handler guides were read from the existing root build checkout's `apps/ui/node_modules/next/dist/docs/`; nothing was installed. H/root still own actual responsive/native verification.

## Canonical dependent revision

Consumed read-only reference: **I35/workspace contract version 1**, root commit `052f6f66f8f8eaca27d5ea878d2cf3024e617dc0`.

- `packages/contracts/src/desktop-workspaces.ts`, Git blob `5c63c27e51b110e0a771492e5f23e83280d0e1fe`.
- `apps/desktop/src/main/workspaces/{catalog,paths,coordinator,receipts,ports,index}.mjs`.
- Root native `runtime.mjs`, `index.mjs`, supervisor boundary, UI server runtime validation and updated assignment standard from that exact commit.

The prepared Round34 base intentionally lacks those I35 files. Owned imports point to the canonical files, not copied or competing workspace definitions. Root must integrate that pinned dependency before resolving/running these sources. This lane did not reset, rebase, cherry-pick or edit central/I35 files. No H UI contract revision was available; H consumes the sole **G remote contract v1 at source commit `8e05c34b35da9c66927bb15f291b43838a8058e2`** below.

## Changed files and concrete adapters

Native main-process files (all new):

- `apps/desktop/src/main/remote-machines/binding.mjs`: `createNativeRemoteMachines`, root-owned lifetime binding, per-workspace coordinators, observational status projection, exact credential callback, confirmed close/retry.
- `.../coordinator.mjs`: `createRemoteMachineCoordinator`, durable pair/select/replace/remove/health, same-ID receipts, effect reservation/lookup, explicit recovery and Stop.
- `.../credentials.mjs`: `createSafeStorageCustody`, existing Electron safeStorage and canonical per-workspace key ports; scoped sealed envelope and private HMAC fingerprint tag.
- `.../network.mjs`: `remoteAddress`, `approvedAddress`, `createPinnedRemoteNetwork`, `createRemoteProtocolClient`; real Node HTTPS/DNS defaults, bounded GET proof and cancellation. Scripted injection is for offline fixtures.
- `.../protocol.mjs`: native validation and explicit public projections/failure allowlist matching the canonical contract version. No runtime dependency on a new native package.
- `.../store.mjs`: `createRemoteMachineStore`, canonical `getWorkspace` and `workspaceDirectory`, private atomic JSON ledger/configuration; no workspace catalog or SQL duplicate.
- `.../supervisor-adapter.mjs`: `createRemoteSupervisorPorts`, concrete available I35 supervisor/admission/draft/local-start bindings and fail-closed named remote transition dependencies.
- `.../fixtures.mjs`, `coordinator.test.mjs`, `network.test.mjs`, `store.test.mjs`: synthetic offline/temporary-directory regression sources, unrun. Fixture cipher/key are test-only, not production custody.

Server files (all new):

- `apps/ui/lib/desktop/server/remote-machines/identity.ts`: `remoteMachineIdentity`, real existing engine-bearer authentication and canonical I35 runtime identity proof handler.
- `.../handlers.ts`: optional `remoteMachineHandlers(bridge,currentActor)` adapter, bounded DTO and stale-window rechecks. It requires a real native bridge; native IPC is the primary suggested route.
- `.../contract.test.ts`, `handlers.test.ts`: strict/masked contract and stale/unavailable HTTP bridge sources, unrun.

Public contract: `packages/contracts/src/desktop-remote-machines.ts`.

This document is the seventeenth changed path. No existing central, UI, runtime, schema, provider, permission, IPC/preload or workspace file was edited.

## H's sole public contract / callback semantics

`DESKTOP_REMOTE_MACHINES_VERSION = 1`. Import existing workspace ID and switch-phase schemas from I35. Public DTOs never include raw/sealed keys, private key tags, HTTP headers, host paths, canonical transition effect maps or native handles.

`DesktopRemoteActor` is `{installId,workspaceId,launchNonce,rendererEpoch}` issued by **native main**, not guessed by the renderer. `rendererEpoch` changes on main-frame navigation/window replacement. Runtime launch identity and renderer lifetime are separate. Recovery startup windows need a fresh native-owned lease, not a copied old renderer identity.

`DesktopRemoteCommand`:

| Action | Additional fields / behavior |
| --- | --- |
| `read`, `reconcile`, `receipt` | actor + requestId. Observational only: read configuration/cache/receipt, no health request, initialization, activation or rollback. |
| `pair` | connectionId UUID, expectedRevision `unconfigured`, address HTTPS origin, apiKey (16–4096 printable ASCII bytes). Explicit read-only proof, sealed local pairing saved; **does not select/activate**. |
| `replace` | exact existing connectionId + expectedRevision, new address/key. New immutable configuration revision. When selected, requires full lifecycle before publication. |
| `select` | exact connectionId + expectedRevision. Explicit proof then root freeze/flush/drain/close/bind/verify/publish/unfreeze. |
| `health` | exact connectionId + expectedRevision. Explicit bounded read-only proof, cache result with a durable request receipt. No tool execution. |
| `remove` | exact connectionId + expectedRevision + confirmation literal `Remove`. Close exact client custody; if selected, explicitly return through canonical local workspace startup/verification. Never delete remote data. |
| `cancel` | actor + the operation requestId being stopped. Cancels exact owned work, preserves uncertain cleanup rather than reporting stopped success. |
| `recover` | actor + the same operation requestId + `resume:true` + fresh `expectedReceiptRevision`. Explicit consent to resume the saved target, not a new target or an automatic restart action. |

`expectedRevision` is the **connection configuration revision**. `expectedReceiptRevision` is the saved **decision/progress receipt revision**. They are distinct. `configurationRevision` in a receipt names the target generation; `receipt.revision` changes with progress. Never send a client-supplied Connected claim.

`DesktopRemoteSnapshot` contains current actor, configuration-store revision, optional safe connection, `selected`, `runtimeState`, `activeReceipt`, `openReceipt`. `selected` is durable binding intent, not a claim of live transport. `runtimeState` is `connected | not_connected | unknown`, read from current native ownership without connecting. Cached health includes checkedAt and is historical. Root must populate the native runtime binding below before any live Connected claim.

`DesktopRemoteReceipt` includes exact install/workspace/connection/request/configuration identity, effect generation, phase, closeAttempted, requiresRecovery and safe reason. `activeReceipt` identifies the actual saved publication for a selected connection; `openReceipt` blocks competing changes while uncertain. Pairing alone returns selected=false.

H callback is `DesktopRemoteMachineBridge.execute(command,signal): Promise<DesktopRemoteResult>` (or the same DTO over preload IPC). H should retain non-secret request IDs/choices, read the same receipt after a lost ACK, then require explicit recovery. The key stays transient in the original password field, is never put in drafts/history/localStorage and is cleared after acknowledged native custody. A native reserved candidate can be recovered without rereading its key into H. If the request never reached custody, human re-entry uses the same immutable request only with the same input; changed input gets a new request.

If H keeps original Connect as one action, it may acknowledge `pair` and then issue a distinct explicit `select` belonging to that still-current human flow. Do not report activation from the pair receipt. No select/health/recover on mount, polling, restore or merely returning from settings. Original non-send controls inside a form need `type="button"`. Old actor/source/revision callbacks cannot update a new window. H owns its UI source and remaining layout/receipt rendering.

## Network and credential guarantees / bounds

- Only an HTTPS origin with no userinfo/path/query/fragment is accepted. Ordinary certificate/hostname verification stays enabled; no TLS bypass/self-signed exception or redirects. TLS public-key pin is checked in TLS `checkServerIdentity` before authenticated HTTP can be sent and again against the connected peer.
- Resolve at most 8 addresses; reject any forbidden answer, pin an address/family, disable alternate-family dialing and HTTP pooling, and verify the peer. Explicit HTTPS LAN/Tailscale addresses are supported; loopback, link-local/metadata IPv4, multicast/unspecified addresses are refused. No loopback HTTP production option. Offline fixtures use injected transports, not opened listeners.
- Probe order is original public `/health`, authenticated `/connections` (bounded/discarded, no local provider login copied), then authenticated `/desktop/remote-machine/identity?challenge=<UUID>`. Every request rechecks current authority; origin/certificate/machine/workspace drift refuses publication. Only these fixed GET paths are available in this client; it is not an arbitrary URL/port/filesystem RPC.
- Challenge response is strict `{identity:{protocolVersion:1,machineId:<stable host installation UUID>,workspaceId:<canonical workspace id>},challenge}`. A matching name, origin, build commit, server restart time or status 200 alone never proves identity. Legacy hosts without this endpoint are unsupported.
- Requests: 10s each (including bounded DNS wait); full operation: 60s; cleanup: 5s; JSON response: 128KiB; optional UI POST body: 16KiB. Provider config bodies are discarded. Commit display is bounded hex metadata; public failures use fixed product messages, never native/server exception text.
- Manual credentials use injected existing Electron safeStorage. The encrypted envelope binds installId, canonical local workspaceId, connectionId and immutable configuration revision. Fingerprints use a private HMAC derived from existing workspace key custody. No ambient API key, engine key or subscription login is used as the remote key.
- `withCandidate(context,consume,signal)` is native-only: root can consume the exact candidate during binding, or the exact still-selected configuration afterwards, without returning a key to IPC/UI. It rechecks before and after awaits. Replacement/removal/cancellation refuses old generations. Do not retain credentials in a renderer or write them to runtime.json/environment/HTTP logs.

## Durable state, restart and failure recovery

State is the **single remote binding for an existing canonical workspace**, not another workspace catalog. File: `workspaceDirectory(installRoot, workspaceId)/remote-machine.json`. Owner is canonical install + workspace. Read uses canonical workspace health, no-follow private regular-file/link/size checks; missing file projects unconfigured without writing. Mutations use canonical private atomic JSON/fsync helpers, local serialization and a fresh revision check. Root must keep its existing single native owner/shared transition gate; multiple independent writer factories are unsupported.

Format version 1 stores encrypted configuration, safe public metadata, original input fingerprint, original accepted actor, current/historical effect identities and receipts. No database migration is needed for this native file. Existing files are never inferred as owned by a matching workspace name. Missing/foreign/corrupt canonical workspace or damaged ledger is an error. Maximum 128 operations, 8 compensated before-drain recovery generations per operation, and 1.9MiB serialized write/2MiB read bound; reject storage-full instead of evicting identities and repeating effects. Health checks count too, which is why H must not poll.

Before every lifecycle await, reserve its effect identity `${receiptId}:${effectGeneration}:${effectName}`. Root returns an exact applied receipt or observational lookup result `not_applied | applied | unknown`. After restart/lost ACK, recovery never repeats a possibly-applied effect just because its response was lost. `unknown` blocks with the same request. No receipt is manufactured by the adapter.

Before drain/close, a failed freeze/flush can be compensated by confirmed unfreeze of that exact root transition. Explicit recovery after confirmed compensation archives all old effect identities and starts a new bounded generation; no identities are evicted. An uncertain compensation remains blocked. The closeAttempted boundary is reserved **before** drain or inactive-client close, so partial cleanup cannot be mistaken for a safe rollback.

After that boundary, failure remains `failed_after_drain` with requiresRecovery=true. No reopening of the old runtime, same-name adoption, local fallback or unfreeze is inferred. Explicit `recover` with fresh receipt revision and resume:true can reconcile/resume the saved target through root's exact effect receipts. Cancel after drain does not unsend/undo already committed effects; new actor consent is recorded for explicit recovery. Late root opens must be closed by root's owned-lifetime port; this source never claims an unconfirmed cleanup succeeded.

Read/reconcile and binding construction never open a connection. Cold start must inspect the saved selection/receipt **observationally** and show disconnected/recovery state until an explicit owner action. Do not silently start the old local engine when remote selection was saved; do not auto-connect the remote either. Root's canonical boot policy owns that choice/gate.

Remove sends no DELETE, power, shutdown, data-dir or server mutation request. On success, delete only that local configuration/ciphertext, scrub historical candidate envelopes for the same connection identity and keep replay fingerprints/receipts. Remote coworkers, memories, files, providers and data remain on their machine. Returning to local execution uses the same I35 workspace identity, never a new workspace.

## Root activation: exact files, interfaces and order

All fragments below are **unapplied**. Named root dependencies remain genuine blockers to production activation; this is not a completed remote-machine product feature.

### 1. Integrate I35 and export the contract

Root must first integrate the pinned workspace files/contract (dependency above) in its own coding checkout, preserving its ongoing Round35 work. Do not solve missing imports by copying another catalog into G. In root `packages/contracts/src/index.ts`, add:

```ts
export * from './desktop-remote-machines.js'
```

The UI schema imports canonical workspace IDs/phases directly. Native runtime validation in `protocol.mjs` is the dependency-free implementation of those same public inputs/version, not a second public contract.

Root's packaging/staging must include production `remote-machines/*.mjs` modules and canonical I35 workspace modules. Do not run/bundle fixture/test entrypoints as startup code. No package install/new native library is required.

### 2. Bind native custody/current renderer and IPC (W1-R-ACTOR / W1-R-IPC)

Root file: `apps/desktop/src/main/index.mjs`. After existing identity/supervisor/draft lifecycle setup:

```js
import { createNativeRemoteMachines } from './remote-machines/binding.mjs'
import { command as parseRemoteCommand } from './remote-machines/protocol.mjs'
import { workspaceIdentity } from './runtime.mjs'
const remoteMachines = createNativeRemoteMachines({
  dataRoot, installId: identity.installId, supervisor, draftQuit, safeStorage,
  workspaceKey: workspaceId => Buffer.from(workspaceIdentity(identity, workspaceId).encryptionKey, 'hex'),
  currentRenderer: () => currentRemoteRendererLease,
  sendDraftFlush: value => window.webContents.send('desktop:before-quit', value),
  transitions: canonicalRemoteTransitionBindings,
})
```

`currentRemoteRendererLease` and `canonicalRemoteTransitionBindings` are named required root additions, not functions already present at this base. Lease fields: `{epoch,workspaceId,launchNonce,recovery?}` plus root's private exact webContents/main-frame identity. Issue epoch with randomUUID on each main-frame lifetime; validate trusted current sender/frame/URL. A trusted recovery startup window needs a newly issued lease when services are drained, not the stale runtime's renderer identity. `checkActor` concretely checks canonical catalog selection, path readiness, current runtime when present and the issued renderer lease.

Root adds two narrow IPC channels (names shared by this handoff):

```js
ipcMain.handle('desktop:remote-machines-context', event => {
  trusted(event)
  // Root must additionally verify the exact current main frame/issued lease.
  return { installId: identity.installId, workspaceId: currentRemoteRendererLease.workspaceId,
    launchNonce: currentRemoteRendererLease.launchNonce, rendererEpoch: currentRemoteRendererLease.epoch }
})
ipcMain.handle('desktop:remote-machines', async (event, raw) => {
  trusted(event)
  const input = parseRemoteCommand(raw)
  // Root validates input.actor against this exact sender/main frame before invoking.
  // Register an AbortController for {frame,rendererEpoch,requestId}; abort only that
  // invocation on navigation/destruction/Stop. Do not serialize AbortSignal over IPC.
  return remoteMachines.execute(input, invocationSignal)
})
```

`invocationSignal` and exact frame checks are W1-R-IPC additions. Recheck the frame/lease after await: if navigation changed it, suppress its stale UI ACK and let the new window read the durable same-ID receipt. Root uses its shared canonical transition gate around select/replace/remove/recover, including interactions with workspace switch, quit, admissions and templates. This adapter never assigns `supervisor.runtime`, changes `selected.json` or rotates a renderer itself.

Root `apps/desktop/src/main/preload.cjs` exposes only narrow methods:

```js
remoteMachinesContext: () => ipcRenderer.invoke('desktop:remote-machines-context'),
remoteMachines: input => ipcRenderer.invoke('desktop:remote-machines', input),
```

H consumes the canonical DTO/result and clears transient secrets. No arbitrary IPC name, URL, filesystem path, credential getter or generic RPC is exposed.

### 3. Extend the existing I35 transition authority (W1-R-TRANSITION / W1-R-APPLY / W1-R-LOOKUPEFFECT)

Root files: existing `apps/desktop/src/main/workspaces/{coordinator,receipts,ports}.mjs`, canonical workspace contracts if additive fields are needed, and root index/supervisor. These source dependencies are deliberately not implemented by a second authority in G.

Required `canonicalRemoteTransitionBindings` shape (native main only):

- `checkOperation(context,signal)` checks the accepted canonical transition lease, exact install/workspace/request/effect generation, old runtime launch and new target identity across expected drain/navigation. An unrelated workspace/window change must invalidate it. A fresh `recoveryActor` must be validated rather than blindly trusting its stored fields.
- `lookupEffect(context,signal)` observationally returns `not_applied`, `applied` with the exact persisted `DesktopRemoteEffectReceipt`, or `unknown`. Missing in-memory data after restart is **not** proof of not_applied.
- `apply(name,context,perform,signal)` uses the canonical transition serialization/receipts to reserve the exact effect, execute the supplied concrete callback, persist its confirmed outcome and return the receipt. Required receipt identity is `{effectId,requestId,workspaceId,installId,connectionId,configurationRevision,applied:true,value}`. Never return applied:true merely because the callback was invoked.
- `drainWork(context,signal)` drains only work owned by the affected local/client runtime. It must not send a global remote-server shutdown or cancel somebody else's remote work.
- `closeOwnedRuntime(context,signal)` confirms closure of the exact old lifetime. If selectedBefore=false (inactive Remove), close only that saved connection's client resources/prove none are owned; do not stop the active local engine by mistake. Confirm late-open cleanup and retain unknown/failed close for retry.
- `bindRemote(context,signal)` is W1-R-BINDREMOTE: missing native gateway/runtime activation, described next.
- `verifyTarget(context,signal)` is W1-R-VERIFYTARGET: confirm requested workspace/machine/configuration and actual bound lifetime; return `{lifetimeId,identity}` for remote or the verified local lifetime for local.
- `publishTarget(context,signal)` is W1-R-PUBLISHTARGET: publish the exact verified target in canonical root authority, return the same lifetimeId, then permit confirmed unfreeze.

Concrete callbacks already bound by `createRemoteSupervisorPorts`: `supervisor.admissions('freeze'/'unfreeze', requestId)` (must return true), `BeforeQuitDrafts.request(sendDraftFlush)` (must acknowledge saved), and local `getWorkspace` + `supervisor.startFor(workspaceId,{...workspace,frozen:true})`. No callback returns placeholder success for an unavailable operation. `assertAvailable` checks required root bindings **before freezing/draining**; it reports exact `W1-R-*` authority names.

The original I35 switch-to-same-workspace branch is a no-op, so do not route a machine change through that branch and claim it worked. Root extends that same coordinator's serialized transition authority with machine-binding context. Keep the catalog/selected workspace identity single and unchanged. If storing machine effect receipts on existing switch records, add optional machine context/effect history and include it in the fingerprint only for the new operation kind; preserve historical local-switch fingerprints. Root owns any additive schema/version migration. G's native state file itself needs no SQL migration or silent startup initialization.

### 4. Actual remote runtime binding (W1-R-BINDREMOTE / W1-R-VERIFYTARGET / W1-R-PUBLISHTARGET / W1-R-BOOT)

Root files: `apps/desktop/src/main/supervisor.mjs`, `runtime.mjs`, root workspace lifecycle, `apps/ui/lib/desktop/server/runtime.ts`, central engine connection/routing boundaries and health payloads.

The current canonical UI runtime requires a loopback engine origin. **Do not loosen it to arbitrary remote HTTPS or put the remote key in runtime.json/the renderer.** Root needs an app-owned scoped loopback engine gateway/remote runtime adapter with a fresh owned lifetime. Resolve its credential through:

```js
await remoteMachines.withCandidate(context, async configuration => {
  // configuration = {address,apiKey,identity,tlsPin,connectionId,revision}; main only.
  // Root's scoped gateway binds the exact approved destination and returns its
  // real lifetime/ownership evidence, not a Connected flag or a model fallback.
  return bindOwnedRemoteGateway(configuration, context, signal)
}, signal)
```

`bindOwnedRemoteGateway` is an explicit missing root component, not shipped or activated here. It must bound/allowlist the canonical engine API transport, keep keys in secure native custody, recheck exact generation via the callback per credential use, propagate Stop and close streams, and never forward local provider login, workspace files, grants or desktop-internal callbacks automatically. Remote and local caches/queues need the existing exact workspace plus connection/configuration/lifetime identity. No fallback to the local provider/model when remote binding fails.

For the existing observational projection, root's in-memory `supervisor.runtime` must carry safe evidence only:

```js
remoteMachine: { connectionId, configurationRevision, identity, lifetimeId }
```

`lifetimeId` must equal that runtime's launchNonce and refer to its actual owned gateway. `createRemoteSupervisorPorts.connectionState` checks those fields plus ready/workspace state; no binding yields not_connected. Expose any health extension from that same verified identity, without secrets. Root verifies remote target using the concrete bounded protocol client with expectedIdentity and stored TLS pin, not a status boolean. Local verification reuses I35's canonical health/workspace identity.

On cold launch, inspect the saved binding/open receipt before choosing a runtime. Preserve disconnected/blocked remote intent until explicit owner action; no silent remote reconnect, old-local rollback or adoption of another same-name machine. Root owns activation and final publication; this slice cannot substitute for it.

### 5. Stable authenticated host identity (W1-R-IDENTITY)

The original engine lacks a stable machine/workspace proof endpoint. Client pairing therefore explicitly fails unsupported until a host provides **GET `/desktop/remote-machine/identity?challenge=<UUID>`**, authenticated by its configured engine key.

For an I35 Mac host, root can mount the concrete helper at `apps/ui/app/api/desktop/internal/remote-machines/identity/route.ts`:

```ts
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export { remoteMachineIdentity as GET } from '@/lib/desktop/server/remote-machines/identity'
```

It uses `authenticateDesktopEngineRequest`, validates the challenge, and returns the canonical runtime installId/workspaceId. Missing install identity returns an error. Root's engine GET route must forward only this fixed identity request through its **existing authenticated, launch-owned loopback app callback** with a short bound, redirect:error, no ambient headers and response validation using `desktopRemoteIdentityProofSchema`. Add only this exact read route to central policy. Root owns `apps/engine/src/http/routes/health.ts`, central route/policy registration and stable data-dir identity migrations for non-Mac remote hosts. Advertise a corresponding health capability only when implemented. Never generate a new machine UUID on each request or use a name/build/port as machine identity.

This helper does not install or expose a listener, accept pairing tokens or register a server. A plain original non-Mac server without that authenticated capability remains unsupported. Root must supply that authority before real remote pairing, with owner approval and QA.

### 6. Optional HTTP management adapter / shutdown

Primary path is native IPC. Only if root has a real renderer-aware native bridge, it may mount POST `/api/desktop/remote-machines` using existing `desktopRoute` and `remoteMachineHandlers(bridge,currentActor).post`. The handlers recheck current native actor before/after awaits and validate returned DTOs. There is no working generic UI-server-to-main RPC at this base; W1-R-HTTP-BRIDGE is a named optional dependency. Do not fabricate currentActor from the client request or create a second credential/configuration registry in the app database.

Root quit/workspace switch calls `await remoteMachines.closeWorkspace(exactWorkspaceId)` / `await remoteMachines.close()` while it still owns the affected lifetime, before services/native references are discarded. Failure throws/blocks cleanup acknowledgement for retry. Abort the exact active invocation on Stop and read its same request afterwards. Construction/read/reconcile never triggers a retry. Root/H's shared App/routers/Control Center/barrel/IPC/packaging/checklist remain untouched by G.

## Supported / dependent / unsupported matrix

| Capability | Implemented source | Root-dependent activation | Unsupported | Boundary |
| --- | --- | --- | --- | --- |
| Manual address/key validation and scoped sealed custody | ✓ | ✓ | — | Existing safeStorage/workspace-key injection and trusted native IPC. |
| Bounded original health/key proof plus HTTPS/machine identity | ✓ | ✓ | — | Real transport adapter; host authenticated identity route is required. |
| Durable pair/health/configuration and exact remove receipts | ✓ | ✓ | — | Canonical I35 ownership imports and root close receipt for removal. |
| Select/selected replace/remove full lifecycle | ✓ | ✓ | — | Coordinator/adapters implemented; canonical effect receipts, gateway and publication remain root authorities. |
| Restart observation, same-ID recovery, compensation history | ✓ | ✓ | — | Root must persist/verify its actual effect receipts and preserve boot gate. |
| Original Servers presentation, narrow/short viewport and native acceptance | — | ✓ | — | H/root UI ownership; no UI edited or executed here. |
| Hosted Docker command/pairing-token exchange/OAuth | — | — | ✓ | Manual configuration only; no hosted actions. |
| Plain HTTP, TLS bypass/self-signed exception, redirects or ambient credentials | — | — | ✓ | Refused by production client. |
| Identity-less legacy host / hostname-only adoption | — | — | ✓ | Explicit unsupported result. |
| Remote data deletion, remote global power/stop, automatic startup reconnect | — | — | ✓ | Deliberately absent. |
| Treating an unbound adapter as an active remote workspace | — | — | ✓ | W1 is not marked accepted. |

## Failure and recovery table

| Failure | Durable / live state | Recovery |
| --- | --- | --- |
| Invalid origin/key, bad certificate, forbidden DNS/peer | Existing binding unchanged; no credential redirect | Correct manual configuration via a new explicit action. |
| Wrong API key | auth_needed, safe error, sealed candidate if reserved | Explicit recovery of unchanged input, or new request for changed key. |
| Missing host proof / different machine or workspace | Unsupported/identity_changed; no adoption | Host implements real identity authority or owner explicitly replaces the exact configuration. |
| Pair/health ACK lost | Same request fingerprint/candidate/receipt retained | Receipt/read/reconcile only; explicit recover with current receipt revision. |
| Freeze/flush failed before destructive boundary | Old runtime retained; rollback only after exact unfreeze confirmation | Explicit recovery archives compensated generation and freezes afresh; unknown compensation blocks. |
| Drain/close/bind/verify/publish ACK lost | failed_after_drain / requiresRecovery; same effect IDs retained | Lookup exact root outcome; applied effects are not repeated, unknown blocks. |
| Inactive close ACK lost | Existing local configuration retained; competing changes blocked | Same close receipt lookup/retry, not an unconfirmed Remove success. |
| Renderer/IPC/workspace changed | Old callbacks rejected; no new window update | New native actor reads exact persisted request; explicit recovery only. |
| Stop/quit cleanup pending | Owned work retained, no successful stopped ACK | Retry Stop/close exact lifetime; root confirms late-open teardown. |
| Publication already committed, final ACK lost | Accepted activeReceipt retained; actual runtimeState read separately | Reconcile same request; no new select or silent rollback. |
| Ledger/canonical path unavailable or corrupt | Error; no auto-healing or same-name fallback | Root-owned explicit recovery, no writes during reads. |
| Storage/recovery bound reached | All existing identities preserved | Root-maintained archival/migration policy; no automatic eviction/replay. |
| Restart with saved remote intent | Disconnected/unknown until root proves current native binding | No connect or local fallback on read/startup; explicit owner action through boot gate. |

## Authored regression sources — unrun

- `coordinator.test.mjs`: pair without activation, key masking, observational replay, immutable input drift, exact lifecycle ordering, scoped credential callback, lost bind ACK/restart without duplicate bind, compensated generation history, owner/revision/window and machine drift, exact Remove with remote-data preservation, unknown receipt blocking, Stop/late proof, offline health recovery, bounded non-evicting receipts, exception-secret redaction, persisted active receipt vs live connection state, inactive close lost-ACK recovery.
- `network.test.mjs`: HTTPS origin policy, alternate loopback/link-local encodings, LAN/Tailscale destinations, original GET proof ordering, credential omission on public health, strict TLS/pinning options, redirect/compression/size/malformed refusal, mixed DNS, Stop during DNS and unsupported/changed host identity. Scripted offline requests only, no listeners.
- `store.test.mjs`: temporary-directory canonical I35 catalog, non-mutating missing-file reads, sealed credentials, unchanged workspace catalog, symlink/hardlink refusal and foreign-workspace credential envelope rejection. No live workspace paths.
- `contract.test.ts`: single version, exact actor/IDs, Remove and explicit recovery fields, no secret-bearing success/error DTOs.
- `handlers.test.ts`: stale native actor after await, missing native bridge, invalid/oversized request errors.

Root still must execute all suites and the root-owned transition/gateway/host/IPC cases, including a full restart and genuine remote machine under owner approval. No authored fixture or check was executed by G. W1 remote client activation and installed acceptance remain pending root; this handoff does not ask the user to send repair work back.
