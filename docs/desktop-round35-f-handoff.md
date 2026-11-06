# Round 35 F — Foreman push-to-talk (E11 / C4)

Source handoff only. No tests, type checks, lint, builds, dependency installation, servers, provider/API requests, browser/native UI, microphone, Keychain or restart checks were executed. Root owns execution, repairs, integration and native acceptance. This does not mark E11/C4 accepted or complete on the shared checklist.

Prepared branch: `desktop/round35-foreman-voice` in `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round35-foreman-voice`. Before editing, branch/HEAD/clean status matched `5c0f589b51a8129d097f2b97fc420a8acf859b51`. All additions are in F-owned paths plus this document. No existing central, generic voice, Foreman, settings, dock or other lane file was changed. No push, merge or publication.

## Original design and source mapping

Read these Git objects at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` before implementation:

| Original file | Preserved behavior / local adaptation |
| --- | --- |
| `apps/ui/components/foreman/dock/usePushToTalk.ts` | Reuse the existing original hook directly: Space held 200ms, no tap capture, composition/modifier/repeat/focus/control/dialog guards, release vs Escape/blur/hidden abort. |
| `apps/ui/lib/foreman/push-to-talk.ts` | Reuse `shouldPushToTalk` through that hook; do not intercept typing or controls. |
| `apps/ui/components/foreman/dock/useForemanVoice.ts` | Human hold starts capture/engages Foreman; release stops, transcribes and sends only the transcript. Null/empty takes never send. Mac adapter uses the app-owned recorder, secure local transcription backend and canonical Foreman admission. |
| `apps/ui/components/foreman/dock/ForemanPillVoice.tsx` | Mount the existing presentation directly. Same recorder-owned stream/waveform, red recording dot, `Listening · release Space to send`, `Transcribing...`, shimmer, truncation and flex behavior. No second microphone. |
| `apps/ui/components/foreman/ForemanDock.tsx` | Traced the real caller: parked pill / working conditions and engagement. G/root retain geometry, board positioning, orb and parked/expanded behavior. F exports a controller and slot, not a replacement dock. |
| `apps/ui/lib/foreman/strip-voice.ts` | Foreman model input remains transcript-only. No raw audio path, synthetic coworker voice marker or text draft is sent with it. |

Applicable `CLAUDE.md`, `apps/ui/AGENTS.md`, `apps/ui/CLAUDE.md`, assignment standard and installed Next.js `use-client` guide were read. Installed guide was read from the existing root build checkout's `apps/ui/node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md`; no dependencies were installed.

Necessary Mac differences:

- Original Foreman discards audio after transcription. This assignment requires immutable attempts and receipt recovery, so bounded audio is retained locally until explicit discard or accepted-try dismissal. It is never attached to the canonical model prompt.
- Reuse `useDesktopVoiceRecorder`, `useDesktopVoicePlayback`, `DesktopVoiceWaveform`, generic `createDesktopVoiceService` validation/state transitions, and `desktopAuxiliaryStore` / `desktopAuxiliaryBackends` without editing them. Foreman is not a row in `desktop_agents`: the generic coworker table FK and tab authority cannot be spoofed. A Foreman-chat FK table adapts the generic service's store/blob interfaces instead.
- Default release keeps original transcribe/send behavior. Explicit Review, Cancel, retained failures and optional `releasePolicy: 'review'` support the accepted Mac recovery flow. Duration/byte caps or microphone inactivity force review, never send automatically.
- Errors are inline beside recovery controls; missing transcription opens the existing Settings > Tool services surface. No hosted action, OAuth, ChatGPT credential borrowing or second voice credential store.

## Implementation inventory / changed paths

One canonical contract:

- `packages/contracts/src/desktop-foreman-voice.ts`

Browser/controller adapters:

- `apps/ui/lib/desktop/foreman-voice/client.ts`
- `apps/ui/lib/desktop/foreman-voice/client.test.ts`
- `apps/ui/lib/desktop/foreman-voice/controller.ts`
- `apps/ui/lib/desktop/foreman-voice/controller.test.ts`
- `apps/ui/lib/desktop/foreman-voice/journal.ts`
- `apps/ui/lib/desktop/foreman-voice/useForemanVoiceSlot.ts`

Presentation / source fixtures:

- `apps/ui/components/desktop/foreman-voice/ForemanVoiceSlot.tsx`
- `apps/ui/components/desktop/foreman-voice/keyboard.test.tsx`
- `apps/ui/components/desktop/foreman-voice/lifecycle.test.tsx`
- `apps/ui/components/desktop/foreman-voice/slot.test.tsx`

Server adapters:

- `apps/ui/lib/desktop/server/foreman-voice/store.ts`
- `apps/ui/lib/desktop/server/foreman-voice/store.test.ts`
- `apps/ui/lib/desktop/server/foreman-voice/runtime.ts`
- `apps/ui/lib/desktop/server/foreman-voice/binding.ts`
- `apps/ui/lib/desktop/server/foreman-voice/api.ts`
- `apps/ui/lib/desktop/server/foreman-voice/admission.ts`
- `apps/ui/lib/desktop/server/foreman-voice/admission.test.ts`
- `docs/desktop-round35-f-handoff.md`

No new package dependency. Uses the existing React, Zod, libsql, Next client boundary, MediaRecorder adapter, IndexedDB/WebCrypto and Node crypto capabilities. No new general grants, engine tool registry entries or coworker/provider authority.

## Public contract and exports

`ForemanVoiceTarget` is `{ chat: {workspaceId,chatId}, model: {connectionId,model} }`, using existing strict Foreman schemas. `attemptId` is a fresh UUID from the human recording action. It is also the canonical Foreman request/run UUID. The private engine session ID is resolved by `ownedForemanChat` only on the server.

Strict requests are `upload`, `read`, `transcribe`, `send`, `cancel`, `discard`. The three revision mutations require the saved attempt `expectedRevision`; an upload uses immutable bytes/metadata and UUID, not a new ID on retry. Upload fields reuse existing voice format/duration/levels/base64 schemas. No client-supplied transcript or Accepted claim is accepted.

`ForemanVoiceSnapshot` contains exact target, sanitized attempt metadata/transcript/revision, optional explicit accepted receipt and optional `setup: 'transcription'`. It omits the generic service's synthetic private scope, dispatch and send-model fields. Snapshot validation cross-checks recording, attempt and receipt identities, including the exact target model/chat. `ForemanVoiceAccepted` requires `attemptId === requestId === runId` and `accepted: true`; acceptance means the canonical prompt was admitted, not that its reply finished.

Exports ready for integration:

- `useForemanVoiceSlot(options: ForemanVoiceSlotOptions): ForemanVoiceSlotController`.
- `ForemanVoiceSlot({voice,onOpenTranscriptionSettings}: ForemanVoiceSlotProps)`.
- `createForemanVoiceController(target, ports)` for source regressions/adapted callers. Methods: `restore`, `start`, `release(review?)`, `transcribe`, `send`, `refresh`, `retrySave`, `cancel`, `discard`, `done`, `prepareForQuit(): Promise<boolean>`, `close`.
- `createForemanVoiceClient`, `foremanVoiceAudioUrl`, `createForemanAudioJournal`.
- `createForemanVoiceRuntime(runtime, db, {isCurrent,shutdownSignal,send})`; methods `handle`, `read`, `audio`, `cancelChat`, `assertAdmission`, `close`.
- `desktopForemanVoice(runtime, shutdownSignal)` binds the existing app DB/Foreman binding and encrypted auxiliary transcription implementation; old runtime ownership is drained before replacement.
- `shutdownDesktopForemanVoice(runtime)` drains an already-open instance without initializing anything during shutdown.
- `canonicalForemanVoiceSend(binding)` calls **only** the root-patched `binding.sendVoice` described below. At this base the method is absent and sending fails closed with 503. It deliberately does not fall back to the unguarded existing `binding.send`.
- `foremanVoiceHandlers(voice).post/audio` for authenticated route mounting.
- `FOREMAN_VOICE_SCHEMA_SQL`, `assertForemanVoiceAdmission(db, turn, assertOwner)`.

## Root integration order and exact fragments

These are unapplied fragments for root-owned files. They are required dependencies, not claims that the application is already wired.

### 1. Additive app-database migration and contract export

The exact base's migration ladder ends at version 24. Root should allocate the next available number after merging its other lanes; do not edit historical migration steps. For the next root migration step use:

```ts
import { FOREMAN_VOICE_SCHEMA_SQL } from './foreman-voice/store'
// In root's existing numbered transaction/migration ladder:
{ version: 25, id: 'foreman-voice-attempts', sql: FOREMAN_VOICE_SCHEMA_SQL }
```

The ordering dependencies are existing voice storage (round32 version 11), auxiliary credentials (version 14) and Foreman chats (round33 version 23). `database.ts` must run this new step after those. Use the existing migration identity checks/transaction discipline. The runtime never silently creates tables on reads. Missing/unavailable storage is an error.

The SQL adds `desktop_foreman_voice_attempts` and cancellation tombstones. It does not insert a Foreman coworker or alter the generic voice backend. In root's contracts barrel, if needed for consumers:

```ts
export * from './desktop-foreman-voice.js'
```

Owned source imports the contract directly, so no barrel file was touched.

### 2. Guard the existing canonical Foreman send, not a new send pipeline

File: `apps/ui/lib/desktop/server/foreman/binding.ts`.

The existing `send` holds `withForemanChatWrite` and preserves the canonical request fingerprint, stored `ForemanTurn`, queued engine receipt and exact run ID. Keep all that behavior. Add a fifth, internal-only guard argument and propagate it through `dispatch`, including its explicit replay fallback:

```ts
import type { CanonicalForemanVoiceSend } from '../foreman-voice/runtime'
type VoiceGuard = { signal: AbortSignal; assertCurrent(): Promise<void> }
const voiceLifetime = new AbortController() // inside createBinding, one per existing binding
async function checkVoice(guard?: VoiceGuard) {
    if (!guard) return
    voiceLifetime.signal.throwIfAborted()
    guard.signal.throwIfAborted()
    await guard.assertCurrent()
    voiceLifetime.signal.throwIfAborted()
    guard.signal.throwIfAborted()
}
```

Change `send(chat,requestId,text,requested?,guard?:VoiceGuard)`. Inside its existing `withForemanChatWrite` callback, check the guard before reading/replaying an old turn, and after awaited model/view/board operations **immediately before** `db.batch` reserves a new turn. Call `dispatch(previous.body,true,guard)` / `dispatch(turn,false,guard)`.

Change `dispatch(turn,replayOnly,guard?:VoiceGuard)`:

```ts
await checkVoice(guard)
// Existing authenticated engine fetch, body, header identity validation and DB receipt stay.
// Its signal becomes:
const dispatchSignal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(guard ? [guard.signal, voiceLifetime.signal] : []),
])
// fetch(..., { ..., signal: dispatchSignal, redirect: 'error' })
// Its existing missing-receipt fallback must preserve the guard:
// if (missing) return dispatch(turn, false, guard)
```

Expose these members from the **same** returned canonical binding:

```ts
voiceShutdownSignal: voiceLifetime.signal,
closeVoiceAdmission: () => voiceLifetime.abort(),
sendVoice: ((input) => send(
    input.target.chat, input.attemptId, input.text, input.target.model,
    { signal: input.signal, assertCurrent: input.assertCurrent },
)) satisfies CanonicalForemanVoiceSend,
```

Also include `String(runtime.workspaceId)` in the existing `desktopForeman(runtime)` cache key (currently only data root, launch nonce and engine origin). F's own runtime key already includes exact workspace/app/engine launch identity.

This root patch is essential: the base `send` cannot take a caller cancellation guard and would otherwise admit a recording after the view/model was closed. The adapter refuses that unsafe path.

### 3. Recheck voice cancellation at the existing authenticated engine admission callback

File: `apps/ui/app/api/desktop/internal/foreman/route.ts`. In the `action === 'admit'` branch, **after** its existing exact saved `ForemanTurn` comparison and before `{ok:true}`:

```ts
import { desktopForemanVoice } from '@/lib/desktop/server/foreman-voice/binding'
// Inside the existing authenticated branch, with the root-patched app binding:
await (await desktopForemanVoice(runtime, app.voiceShutdownSignal))
    .assertAdmission(input.turn, request.signal)
```

This concrete adapter checks saved target, transcript, send intent, cancellation and epoch, plus private session ownership and current model availability. Ordinary text turns with no voice attempt continue through the existing authority unchanged. It neither creates nor sends anything.

Root must retain the existing engine route's current binding/signal/agent/model checks under `withAgentLock` in `apps/engine/src/desktop/foreman/routes.ts`. There is an existing await boundary at `reserveDesktopQueuedTurn` before `runAgent`. To close the cancellation-after-reservation window for voice, recheck `bridge.admit(exact, signal)` and `signal.throwIfAborted()` inside the stream callback immediately before invoking `runAgent`. If that check fails **after reservation**, terminally cancel that exact saved run with the existing engine DB run cancellation and release its session claim; keep the already-committed queued receipt/history truthful. Never retry or move it to a new run ID. Keep this in the canonical route/runner; F did not edit engine or provider lifecycle.

For clarity, this is the additive body of that existing engine callback's `try` before the unchanged `runAgent` call:

```ts
await bridge.admit(exact, signal)
signal.throwIfAborted()
if (readBinding() !== bridge) throw new HttpError(409, 'Foreman app launch changed.')
// Existing runAgent + mergeRunStream follow, with the existing exact turn/run IDs.
```

In its existing callback `catch`, add `await cancelRun(FOREMAN_AGENT_ID, turn.runId)` using the existing DB repo export before releasing the session claim and throwing; do not return a completed provider response. This records the already-reserved prompt as cancelled if no provider may start. Root must propagate cancellation checks through any later provider-preparation await in the canonical runner as needed; this lane does not modify provider lifecycle.

A turn whose canonical reservation already committed is an accepted turn even if Cancel races its HTTP ACK. UI Cancel must not claim to unsend it. Root's normal Stop cancels such an admitted run; the receipt remains accepted. Root must verify this admission/Stop race, including provider teardown, before native acceptance.

### 4. Authenticated browser route

Root creates `apps/ui/app/api/desktop/foreman/voice/route.ts`:

```ts
import { desktopRoute } from '@/lib/desktop/server/http'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { desktopForemanVoice } from '@/lib/desktop/server/foreman-voice/binding'
import { foremanVoiceHandlers } from '@/lib/desktop/server/foreman-voice/api'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const app = await desktopForeman(runtime)
        return foremanVoiceHandlers(await desktopForemanVoice(runtime, app.voiceShutdownSignal)).post(request)
    })
}
export async function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const app = await desktopForeman(runtime)
        return foremanVoiceHandlers(await desktopForemanVoice(runtime, app.voiceShutdownSignal)).audio(request)
    })
}
```

The existing local cookie/host/origin checks remain mandatory for both methods. If root maintains a broader route allowlist in its integration checkout, add only these exact methods/path; no wildcard/filesystem RPC. Audio URLs contain local chat/model/attempt IDs only. POST uses existing bounded JSON reading (3 MiB, existing 10s read deadline); operations have 120s maximum; client response is bounded at 400KB and deadline at 125s. GET verifies exact scope/hash and returns bounded original supported audio bytes with no-store/nosniff. No auto-transcription GET.

### 5. Stop, close and shutdown

`apps/ui/app/api/desktop/foreman/route.ts`, existing human Stop branch:

```ts
const voice = await desktopForemanVoice(runtime, app.voiceShutdownSignal)
await voice.cancelChat(input.chat) // abort + persist exact attempts, drain up to 5s
await app.stop(input.chat)        // existing canonical run/discovery Stop
return Response.json({ ok: true })
```

If either step fails, propagate the failure and allow Stop retry; do not return `{ok:true}` while cleanup is unknown. Existing accepted turns remain accepted, never replayed by cancellation.

For graceful Mac shutdown, the existing supervisor already calls authenticated `/api/desktop/internal/mcp` with `action:'shutdown'` before stopping UI/engine children. Root can extend the existing branch in `apps/ui/lib/desktop/server/mcp-binding.ts` without adding a new external protocol:

```ts
await shutdownDesktopForemanVoice(runtime) // does not open a runtime on quit
await shutdownDesktopRemoteMcp(runtime)   // existing tool drain
return Response.json({ stopped: true }, { headers: { 'Cache-Control': 'no-store' } })
```

The import is from `./foreman-voice/binding`. Close the already-open canonical Foreman voice admission lifetime as part of root's Foreman shutdown if root retains that binding; do not initialize a new Foreman chat just to shut it down. F's `.close()` already invalidates its own lifetime synchronously, aborts every owned operation and waits for settlement; it throws after 5s instead of reporting a successful drain.

At the renderer's existing `DesktopApp.tsx` `onBeforeQuit`, retain a ref to the mounted voice controller and combine its boolean with the existing `chatReady`, `brainReady`, `foremanReady` results:

```ts
const voiceReady = foremanVoiceRef.current
    ? await foremanVoiceRef.current.prepareForQuit()
    : true
const ready = chatReady && brainReady && foremanReady && voiceReady
```

Freeze admissions using the existing draft quit mechanism first; include this work before returning the final quit ACK. A local recording-storage error must keep the view/app open. `holdDraftAdmission` already covers in-flight audio custody writes and the hook's cancellation handshake; the explicit boolean covers failures rather than silently treating a settled rejected write as durable. G/root can use the same method before a destructive view/model switch when a take has not yet reached local custody. No root text-draft state is cleared by F.

### 6. G's typed slot and settings mounting

There is no round35 shared agreement or G contract revision in this prepared checkout. Dependency revision is therefore **not available at this base**, not guessed. F's exact exports are `ForemanVoiceSlotOptions`, `ForemanVoiceSlotController` and `ForemanVoiceSlotProps`; G owns the geometry that consumes them. No other lane source was copied.

Use a stable mounted board owner with the existing local Foreman chat and explicit resolved selected model. Do not fabricate a coworker or private engine session to fill the target:

```tsx
import { useForemanVoiceSlot } from '@/lib/desktop/foreman-voice/useForemanVoiceSlot'
import { ForemanVoiceSlot } from '@/components/desktop/foreman-voice/ForemanVoiceSlot'
// Inside G/root's mounted owner, once canonical chat + selected model are available:
const voice = useForemanVoiceSlot({
    target: { chat, model: selectedModel },
    active: voiceAllowedForCurrentBoard,
    onEngage: engageExistingParkedForeman,
    onAccepted: () => { void existingForemanClient.refresh() },
    releasePolicy: 'send',
})
foremanVoiceRef.current = voice.controller
const voiceSlot = <ForemanVoiceSlot voice={voice}
    onOpenTranscriptionSettings={openExistingToolServicesSettings} />
```

Names `chat`, `selectedModel`, `voiceAllowedForCurrentBoard`, `engageExistingParkedForeman`, `existingForemanClient`, `foremanVoiceRef`, `openExistingToolServicesSettings` are typed root/G state bindings at the mount, not new server APIs. `onAccepted` refreshes the existing turn only. Never call `sendMessage`/send a follow-up or clear the typed draft from it.

Compute `active` from the current workspace/chat/model ownership, eligible parked board UI, app admission/quit state, dialogs/other controls, and **the actual Foreman run**. Preserve engagement while a held capture is active. Do not derive `active` from F's `starting/saving/transcribing/sending` phases; doing so would cancel the operation itself. On close/switch/Stop set it false immediately. The target-key/ref and mount lease reject stale callbacks even before effect cleanup. On real unmount the lease becomes invalid synchronously, hardware closes on cleanup, and listeners/observers detach. StrictMode's immediate effect reattachment does not permanently close a live controller.

Root/G keep the original parked-pill position/orb/track classes and outer short-viewport scrolling. The slot uses min-width zero, wrapping controls and a scrollable bounded transcript, no fixed dock geometry or new layout. Actual 375px/768px/desktop/short-screen acceptance is root's unrun responsibility.

The real existing setup surface is `DesktopSettings` > **Tool services**, which mounts `DesktopAuxiliarySettings` and uses `/api/desktop/auxiliary`. Its base props do not expose a focused-tab API; root supplies a narrow focus callback/optional initial tab to the existing settings host. Do not invent a URL or credentials form in the voice slot. If root needs a focused-tab prop, add `initialTab?: 'AI providers'|'Tool services'|'Workspace'|'Notifications'|'Shortcuts'` there and initialize the existing tab state from it; root opens that existing host with `initialTab="Tool services"` only on this human setup action. Returning from setup requires an explicit Transcribe/Refresh, never a resumed automatic send.

## Durable/restart and cancellation behavior

- Each human capture reserves one UUID in memory. A released valid take is SHA256-bound and committed to IndexedDB before any upload/provider/send. Eight pending takes maximum, one per exact target, 2 MiB each. Failure retains the Blob in this view and blocks network effects until retry; root must honor the quit/close boolean if local custody cannot be saved.
- App DB stores immutable target/fingerprint, bounded verified audio, revision/epoch, send intent and accepted run. The generic service's synthetic adapter scope is private and never becomes a real coworker/session. Bytes cannot be replaced under the same ID; cancellation tombstones prevent a late first upload after Cancel.
- Microphone capture uses the existing app recorder: its real tracks, sampling timer, analyser and AudioContext are released by stop/cancel; late microphone grants are cancelled. No authentication or permission prompt is requested until a human action. Space released before permission resolves yields no take and no send. Under-250ms takes are ignored with the original empty-recording wording.
- Restoring/opening reads pending local custody and the exact server attempt/receipt only. It never opens a microphone, retranscribes, uploads again or dispatches a turn. No voice polling loop. A new model/chat/workspace cannot adopt the old target's audio, transcript or receipt. Return to that exact target to review its pending take.
- Explicit Save retries exact audio; explicit transcription retries the same take/revision. Once `send_requested` is recorded, retranscription is refused to keep the canonical turn text immutable. Explicit send retry uses the same request UUID/text/model and canonical Foreman receipt path. Read-only receipt recovery queries only that run, without replay/another turn or acceptance callback.
- Browser/session loss after acceptance does not lose identity: cache the accepted run before the generic final draft CAS, or recover it from the exact saved turn + matching engine run/session. Failed/unknown lookup yields no receipt, not a fabricated success. If the engine's queued receipt survives a restart, the explicit same-ID retry remains the existing canonical replay path.
- Cancel invalidates client operation epochs, aborts exact network work, stops hardware and preserves released audio for review. Server mutation controllers are registered before awaited authority reads; Cancel/Stop persists a fence and drains those exact jobs. Cancel acknowledgement failures remain retryable errors. It cannot unsend an admitted turn; use normal Foreman Stop for its run.
- Discard removes only unreferenced unsent audio, retaining an attempt tombstone. Any send intent is conservatively retained until an explicit accepted result is known. Done removes only the browser pending entry after an accepted receipt; server audio/turn receipt stays durable. Text drafts are never inputs to this controller.
- Foreman audio is capped at 32 MiB in the app DB. Foreman writes also check the current combined generic/Foreman 128 MiB budget; the generic backend was not modified to account reciprocally for Foreman writes, so this is not a claim of a new cross-backend global quota invariant.

## Implemented / dependent / unsupported matrix

| Capability | Implemented source | Root dependency | Unsupported | Notes |
| --- | --- | --- | --- | --- |
| Original Space hold/release and recording/processing presentation | ✓ | ✓ | — | Existing original hook/pill reused; G/root mounts slot and engagement. |
| App-owned mic, review, short/empty/cancelled/limited captures | ✓ | ✓ | — | Root checks packaged Chromium/microphone; no capture executed here. |
| Immutable local attempt/audio custody, revision and accepted identity | ✓ | ✓ | — | Root adds numbered app migration and quit gate. |
| Secure existing transcription backend / real setup UI | ✓ | ✓ | — | Existing configured auxiliary service; root mounts route/focused Settings host. |
| Canonical same-ID Foreman send and uncertain ACK recovery | ✓ | ✓ | — | Requires guarded `sendVoice`, engine callback fence and post-reservation provider guard. Plain unpatched send is refused. |
| Stop/model/workspace/quit ownership cancellation | ✓ | ✓ | — | Root connects canonical Stop/shutdown/admission checks; accepted-run Stop remains canonical. |
| Always-listening, auto-record/transcribe/send after restart | — | — | ✓ | Deliberately absent. |
| New voice credentials, grants, coworker voice registry or hosted Foreman actions | — | — | ✓ | Deliberately absent. |
| Audio sent to Foreman model / new voice bubbles in shared history | — | — | ✓ | Original transcript-only prompt; no shared renderer edits. |
| Recovering unsaved in-flight microphone chunks after a hard crash | — | — | ✓ | Only released, durably saved takes can recover. |

## Failure / recovery table

| Failure or interruption | Retained state | Human recovery |
| --- | --- | --- |
| Tap or release before permission | No usable take; text unchanged | Hold again. |
| Permission denied / capture unsupported / empty transcript | Real capture/error state; saved released audio if present | Check browser mic permission or retry/transcribe/review; no invented text. |
| Local IndexedDB failure/quota | Blob remains in this open view; no upload/transcribe/send | Retry Save; root blocks quit/close on failed durable-custody gate. |
| Upload ACK lost / bytes not saved | Same local Blob/UUID; server attempt may exist | Refresh, then Save recording with exact take. |
| Transcription unconfigured | Saved bounded take, unavailable setup state | Open existing Tool services settings, then explicitly retry Transcribe. |
| Provider failure / rotated credential | Same audio/attempt, no synthetic transcript | Explicit Transcribe after configuration recovery. |
| Send ACK lost | Same transcript/model/UUID; send intent and possible canonical run | Refresh reads receipt; explicit same-ID Send only if still unknown. |
| Model/chat/workspace changed | Original target's local journal entry | Return to exact target; stale callbacks cannot update the new target. |
| Cancel/Stop races admission | Durable cancellation fence; accepted receipt if already admitted | Refresh exact receipt and normal Foreman Stop; never claim an accepted turn was unsent. |
| Cleanup deadline exceeded | Owned job still tracked; no successful drain ACK | Retry Stop/quit; root does not terminate services as though cleanup succeeded. |
| Restart | Saved config/audio/revisions/turn receipt | Passive reads only; explicit retry after review. |
| Root omitted send patch | Audio/transcript saved; send fails closed | Root integrates the documented binding/callback/runner patch; no unsafe fallback. |

## Authored regression sources — not executed

- `controller.test.ts`: release saves before provider work; exact-ID upload/transcribe/send; passive restore has no effects/callback; late microphone open drains after close; changed owner rejects late upload; lost send ACK is read-only recovered; Review/short capture; local custody failure blocks effects/quit; Cancel ignores late transcription; accepted callback deduplication; permission failure; Done permits a subsequent human capture.
- `client.test.ts`: strict public DTOs exclude private session fields, contradictory/foreign receipts and stale workspace/chat/model ACKs; service errors and oversized replies cannot produce success.
- `keyboard.test.tsx`: original 199/200ms threshold, focused input, dialogs, composition, window-loss abort rather than release.
- `lifecycle.test.tsx`: simulated recorder only, no real microphone: hydration has no capture/network effect; closing/switching invalidates capture; dialog/window loss cancels without sending.
- `slot.test.tsx`: pointer hold/release vs normal lost pointer capture, stale hold cancellation on eligibility change; existing transcription setup callback and no credential field.
- `store.test.ts`: synthetic in-memory DB only: immutable bytes/target, epoch/cancel CAS, cancel-before-first-upload tombstone, missing canonical send adapter fails closed.
- `admission.test.ts`: saved cancellation/model/transcript substitution/epoch race rejected at callback; ordinary text remains delegated to existing Foreman authority.

Existing app recorder/provider/Foreman suites are dependencies for root's execution. Root must additionally exercise the root-owned route/admission/post-reservation/Stop race, real audio decoding and secure backend, failed/unknown engine receipt, model removal, quit drain, packaged permissions and restart from the exact integrated commit. All source fixtures above are authored and unrun; no installation or native acceptance was attempted.
