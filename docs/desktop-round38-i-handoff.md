# RD38 I — remote gateway / durable machine transitions

Implementation: `ca222cdc30cd418d7b675887f5150f6a68e12571`; callback-admission cancellation fence: `921330ffedbadb9be9cd3db7e66125992b2ae2ad`; refusal and provenance fence: `1dadc94b7d59ae8ec45f7fd6adb20a837c49b16c`.
Branch `desktop/round38-i-remote-gateway`; initial branch/clean status and exact base `6f6ad959a09abaf1947950b6f82413c94407e22a` verified before editing. This handoff is committed separately. No hooks were bypassed.

**Source only; optional remote track remains gated and does not block the local Mac milestone.** No checks executed: tests, fixtures, typecheck, lint, builds, installs, provider/network requests, servers/listeners, Docker, native/browser UI, credentials/Keychain, accounts or restart checks. No push, PR, upload or acceptance claim. No installed-app or live workspace data read. Root owns all execution, review, repairs, migration allocation and activation.

## Inspected originals: transport, authentication, ownership

Reference checkout verified at exact original pin `2a57fa6dd53311f763bfc9abde85997b7f7e5309` (read only):

- `apps/ui/app/api/_services/servers.service.ts`: self-hosted app creates hashed `rrn_pair_` tokens (15-minute TTL), checks public health, then proves the supplied engine key through authenticated listConnections; token claim precedes attach. Manual attach resolves to a workspace engine; detach preserves remote data.
- `apps/engine/src/http/routes/health.ts`: `/health` exposes status/counters/capabilities/build metadata; **no stable machine-installation UUID or workspace challenge response**.
- `apps/engine/src/http/auth.ts`: engine API bearer/key authentication. It is not a revocable per-desktop gateway session or remote identity challenge protocol.
- `apps/docs/self-host/servers.mdx`: engine initiates pairing through `RERUN_HUB_URL/api/engines/pair`, sends its key/token, and keeps engine data on the server. This is hosted/self-hosted web authority, not permission to enable a new Mac inbound listener.
- `apps/ui/components/dialogs/ServersDialog.tsx`, cloud-OSS server surface and server actions located as the original UI/caller references; existing RD36 UI already ports that surface. No new UI was authored.

The existing RD36 Mac client requires `/desktop/remote-machine/identity?challenge=<UUID>`, authenticated, with exact `{identity:{protocolVersion:1,machineId,workspaceId},challenge}`. The reviewed original exposes **no such public route**. Nothing in `/health`, a server name, a returned connection list, a TLS certificate alone or a cached metadata row supplies that workspace proof. This remains a hard gate, not a claim that the original is compatible. No server endpoint, gateway wire protocol, token exchange, pairing command or host was fabricated.

Mac adaptations already present and retained: HTTPS-only destinations, pinned DNS and TLS public-key identity, fixed read endpoints, encrypted workspace/connection/revision/address/certificate custody, source-runtime drain and explicit recovery. We do not adopt the original Docker launcher/host substitution, hosted Supabase authority or token redemption route as local permission.

Read repository CLAUDE, assignment standard, checklist, upstream review, received RD36 handoffs and RD37 plan. Relevant existing references: `docs/desktop-round36-{g,h}-handoff.md`; native `remote-machines/{protocol,store,credentials,network,coordinator,binding,supervisor-adapter,ipc}.mjs`; canonical `packages/contracts/src/desktop-remote-machines.ts`; workspace private persistence helpers. No RD37 or another owner source was modified.

## Findings classified

| Finding | Classification | Action |
| --- | --- | --- |
| Actor install/workspace/launch nonce/renderer epoch; strict IPC caller fencing | Already implemented | Reuse canonical actor schema and root actor check |
| Pair/replace/select/remove intent reservation, encrypted candidate custody, explicit same-ID recovery, bounded non-evicting history | Already implemented | Reuse existing remote-machine coordinator/store; do not create another catalog |
| Private workspace JSON, atomic fsync/rename, owner/path checks, immutable connection revisions | Already implemented | New effects append only to the exact existing operation |
| Supervisor callback effect receipt authority (`apply`, `lookupEffect`, `checkOperation`) | Concrete missing code | New durable native effect gate below |
| Late observation provenance across runtime/renderer/config changes | Concrete missing local fence | New predicate over existing actor/runtime/connection fields |
| Remote protocol identity/challenge and full gateway/session behavior | Missing public protocol dependency | No network gateway implementation or Connected claim |
| Native actor publishing, actual drain/close/bind/verify/publish callbacks, existing credential custody hookup | Root integration/configuration | Typed binding fragments below; no fake callbacks |
| Certificate exception, inbound hosting, a specific supplied server or trust/pairing policy | Product decision / explicit future configuration | Not authorized here; no TLS bypass or fallback |
| Prior unchecked remote acceptance | Root verification | Not evidence to duplicate implemented RD36 paths |

Dependencies: RD36 G received runtime tip `abffeb7d71f2a973f7c4951d244498e30cea05dd`, H UI tip `12d9bbf91e6a626367d2772965fd24e8f7fec7e6`, integrated source present at this RD38 base. Canonical remote contract version 1. Workspace authority is existing version 1; no second identity catalog.

## Changed files

All new, under the dedicated owned package:

- `apps/desktop/src/main/remote-gateway/transitions.mjs`
- `apps/desktop/src/main/remote-gateway/transitions.d.mts`
- `apps/desktop/src/main/remote-gateway/transitions.test.mjs`
- `apps/desktop/src/main/remote-gateway/observations.mjs`
- `apps/desktop/src/main/remote-gateway/observations.test.mjs`
- `apps/desktop/src/main/remote-gateway/runtime.mjs`
- `apps/desktop/src/main/remote-gateway/runtime.test.mjs`
- `docs/desktop-round38-i-handoff.md`

No existing supervisor/IPC/startup/custody files, contracts barrel, routes, checklist, database ladder or other worktree were edited. Earlier unfinished C source remains preserved in its own tree; this I task does not resume/edit that package.

## Implemented journal / recovery semantics

`createRemoteTransitionGate({store,assertActor})` consumes the **existing** remote-machine store. Its `read/mutate` binding must be the same serialized store instance as the coordinator. Effects are stored as `operation.lifecycleEffects[effectId]`, not another file, connection database or credential store. No secrets, addresses, certificate material or arbitrary exception strings enter the new effect records.

The canonical `DesktopRemoteEffectContext` is reused: exact install/workspace/request/receipt/connection/configuration revision/source launch nonce/effect generation/target. Effect ID must equal `${receiptId}:${generation}:${name}`. Changed context refuses before callbacks. Supported names are the existing freeze/flush/drain/close/bind_remote/bind_local/verify/publish/unfreeze list.

- Durable reservation precedes each actual callback. Existing store atomic persistence must succeed before invocation.
- Already applied retries validate the exact fingerprint and receipt; return that receipt without another callback.
- A reserved effect on restart is Unknown. A missing native result is not negative proof and never authorizes replay. Reads do not invoke callbacks.
- A callback error, abort, stale actor, target change or ambiguous receipt-write acknowledgement retains the reservation. Lookup may recover an actually persisted applied receipt after a lost write ACK.
- Receipt values are allowlisted (saved/closed/lifetimeId/identity). Flush and close require positive acknowledgements; binding/verify/publication require exact UUID lifetime; remote binding/verification/publication additionally require exact target identity. No Connected flag is generated.
- Per-operation supplemental history is capped at 81 (nine names × generations 0–8), consistent with canonical recovery bound. Existing file/operation size caps remain authoritative and refuse new work instead of evicting replay identities. Old generations remain stored; a current-operation lookup does not adopt them.
- Work is serialized in one main-process lifetime. Each apply has linked caller/shutdown/60-second cancellation. `close()` freezes admission, aborts owned waits and waits up to 5 seconds for both callback and native effect completion. An undrained callback causes an explicit uncertain failure; custody must stay retained. It never kills unrelated browser/windows/processes.
- Root must honor the signal passed into a callback for cancellable physical work. The existing supervisor adapter closes over its caller signal; root must thread the linked effect signal when integrating. No wrapper can prove a non-cooperative native callback stopped merely because its await was cancelled.

`acceptsRemoteObservation({expectedActor,currentActor,capturedRuntime,currentRuntime,connection})` compares existing actor epoch/workspace/source lifetime plus exact remote runtime connection/configuration/identity/lifetime. It is a local provenance predicate for root's already validated frames/results, **not a parser, remote proof, certificate validator or live Connected test**. Network/TLS/remote proof still precede its use; changed address/certificate must invalidate the canonical configuration revision/custody through existing machinery.

## Public typed port / root activation fragments

`transitions.d.mts` imports existing `DesktopRemoteActor`, `DesktopRemoteEffectContext`, `DesktopRemoteEffectReceipt`, `DesktopRemoteIdentity` and `DesktopRemoteReceipt` directly from the canonical contract. It declares the minimal journal store, callback and return types; no new wire contract or exports are required.

Root composes one gate per owned workspace using the SAME store instance passed to `createRemoteMachineCoordinator`:

```js
import { createRemoteTransitionGate } from './remote-gateway/transitions.mjs'
const transitions = createRemoteTransitionGate({
  store: remoteStore,
  assertActor: (actor, context, signal) => nativeOperationActorAuthority.assertCurrent(actor, context, signal),
})
```

`nativeOperationActorAuthority` is the required root binding to current install/selected workspace/renderer epoch and **the canonical operation-owned runtime lifetime**. It is not a new actor registry or a callback that returns true. Keep source actor custody frozen during an admitted transition; after restart only the existing explicit recover command may attach a newly checked `recoveredBy` actor. No startup recovery/pairing/network effect.

The existing `createRemoteSupervisorPorts` accepts a `transitions` object. Root supplies the following methods on its existing canonical transition adapter:

```js
const transitionPorts = {
  checkOperation: transitions.checkOperation,
  lookupEffect: transitions.lookupEffect,
  apply: transitions.apply,
  drainWork: ownedRuntimeTransitions.drainWork,
  closeOwnedRuntime: ownedRuntimeTransitions.closeOwnedRuntime,
  bindRemote: ownedRuntimeTransitions.bindRemote,
  verifyTarget: ownedRuntimeTransitions.verifyTarget,
  publishTarget: ownedRuntimeTransitions.publishTarget,
}
```

The last five are **missing root physical authorities**, not implemented success shims. Their existing required signatures are `(DesktopRemoteEffectContext, AbortSignal) => Promise<DesktopRemoteEffectReceipt['value']>`. Freeze/flush/unfreeze and local startup callbacks already exist in the supervisor adapter; do not duplicate them here. For `apply(name,context,callback,signal)`, adjust root's callback to accept/use the linked signal supplied by the gate. Retain exact `fromLaunchNonce`; do not close whatever runtime happens to be selected later.

`canonicalRuntimePorts(supervisor)` in `runtime.mjs` is a hard gate, not those authorities. Every method throws `authority_missing` and does not call `supervisor.stop`, `confirmToolsStopped`, a listener, or a host. Do **not** pass that object as `transitions`: a present `drainWork` or `closeOwnedRuntime` makes `assertAvailable` succeed, and the coordinator can freeze the workspace before the refusal. Leave those five methods absent until root has a real acknowledgement. `projectRuntimeBinding` returns `not_connected`, `unknown`, or `admitted`. It never returns `connected`. Saved `health.state === 'connected'` stays `not_connected` when no remote binding exists, and `unknown` when a binding has no applied receipt.

Root's current `createNativeRemoteMachines` creates its store inside a closure and takes one `transitions` object. To share that store, compose the gate at the existing per-workspace factory location in `binding.mjs`, then feed its transitions to that workspace's `createRemoteSupervisorPorts`; do not create two store instances with independent serialization. This is a root-owned patch, not applied here. Native custody continues exclusively through `withCandidate` and existing `createSafeStorageCustody`.

For result/frame delivery, after existing network/protocol validation, pass root's captured actor/runtime and current canonical actor/runtime to `acceptsRemoteObservation`. Reject false without changing selected chat/drafts/board/defaults. Never treat true as evidence that a server is Connected; only the already existing live verified supervisor runtime state may do that.

Shutdown order: block new IPC commands → cancel the existing coordinator/owned source operations → await gate close and existing runtime drain → release exact transport/candidate handles only when outcome/closure is known. If close throws uncertain, preserve custody/journal and surface recovery; do not tear down the old owner and start local as a fallback. Keep the same apply identities after a lost ACK. A reserved unknown requires real root/native effect proof or explicit blocked recovery; this package does not fabricate a way to guess the remote outcome.

## Persistence / migration

The new optional `lifecycleEffects` member is additive to existing operation records in `remote-machine.json`. Older records have none; no effect is inferred as applied. Root appends the appropriate native data-dir migration/validation version in its owned ladder and validates supplemental fingerprints/states/receipts before activation. Existing canonical file validation is shallow for these new rows; every consumed row is revalidated by the gate. No migration numbering or shipped step was edited. Preserve all old candidate/active ciphertext and the complete request journal; never delete unknown records to free space.

## Meaningful authored regression sources — none executed

- Reservation visible before callback; duplicate request returns exact receipt and callback executes once.
- Failed/lost-ACK callback stays Unknown over a new gate instance, refuses repeated effects.
- Wrong workspace, configuration revision and source launch nonce refuse before callbacks.
- Shutdown interrupts an unacknowledged callback; late completion does not convert its reserved row to Applied.
- Observation accepts exact owned lifetime and rejects changed renderer epoch, runtime nonce, configuration revision, certificate pin, destination address, or missing connection.
- Saved health `connected` projects `not_connected` or `unknown`, never `connected`. An applied lifetime match projects `admitted`.
- A credential and an oversized extra field are absent from the journal, and the effect does not become applied.
- `canonicalRuntimePorts` refuses drain, close, bind, verify and publish while the injected `stop` and `confirmToolsStopped` stay at zero calls.

Additional root integration cases remain: physical freeze/drain, actual remote proof/certificate changes, owned IPC actor epochs, secure custody across replace/remove, restart with real native effect receipts and full Quit. No fixture claims a real server exists; no test/fixture/network request was run.

## Limits and disposition

| Area | Source disposition |
| --- | --- |
| Existing actor/custody/intent journal/UI | Reused, not duplicated |
| Durable native pre-effect reservation and exact applied ACK replay | Implemented source |
| Restart reading and unknown refusal | Implemented source; never auto-resumes |
| Physical drain/close/bind/publish | Refusal source only. Not wired. Calling supervisor.stop is not a remote acknowledgement |
| Remote challenge/gateway/session/frame wire protocol | Hard gate: unavailable in reviewed original |
| New hosts, inbound listeners, credential activation, startup pairing | Unsupported / not authorized |
| Connected state | Never derived from metadata or this helper |
| Local Mac milestone | Independent of this optional track |

Risks: non-cooperative callbacks retain unknown work; root must not release custody after a timeout. Main-process serialization assumes one canonical writer; multiple stores/processes must not race the same JSON. Explicit recovery generations and certificate review remain with canonical coordinator/native authority. This is a usable journal source package, **not a completed remote runtime or installed acceptance**.

## Proposed draft PR — not published

Title: `Reserve remote lifecycle effects durably and fence stale observations`

Body: Add native effect reservation/receipt recovery to the existing remote-machine operation journal. Exact actor/configuration/lifetime checks prevent duplicate effects after interrupted or lost acknowledgements, and a provenance helper rejects late observations from replaced runtimes. Remote transport remains gated because the reviewed public engine lacks the required workspace identity proof. Root must bind physical transition/actor authority and the additive persistence validation. Regression sources are authored and unrun; no network or Mac acceptance performed.
