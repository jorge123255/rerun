# Round 28 E2 — reviewed native temporary edits

Base `15dce4a9dcefeb95b0042d01d8b2afc9bbe5c3f6`, branch `desktop/round28-native-writeback`. Source-only handoff. Root lifecycle/permission/route/migration/UI integration and execution/native acceptance are pending. No capability is marked accepted.

## Original implementation and Mac adaptations

Read from original pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:
- `apps/engine/src/tools/builtin/filesystem.ts` delegates fs tools to the coworker workspace; `tools/builtin/fsTools.ts` is the original fs_write/fs_edit design already used by the current private publisher.
- `apps/engine/src/tools/builtin/shell.ts` executes directly in the workspace, with a cancellable shell and bounded output. The Mac worker uses isolated copies instead; this lane never executes a shell during capture or review, and never treats a temporary change as a publication.
- `apps/ui/components/chat/ActionApprovalBlock.tsx`, `ApprovalBlock.tsx`, and the actual reusable `packages/ui/src/chat/ActionApprovalBlock.tsx` / `ApprovalBlock.tsx`: original approval card, scrollable code preview and Approve/Not now language. The new component reuses ActionApprovalBlock with a complete removed/added textual preview. It does not introduce a new editor, broad permission prompt or generic request_approval handling.

Current-base sources read: `apps/engine/src/desktop/native-worker.ts`, `workspace-read.ts`, `open-without-links.ts`, `runtime/loop.ts`; UI `private-file-tools/publication.ts`, `snapshot.ts`, `schema.ts`, and `coworker-files.ts`. The publisher now checks complete content, SHA/version/inode/directory identities rather than transferring any authority from an approval choice. Installed Next route-handler guide was read; no dependency installation.

## Changed files and exports

- `apps/engine/src/desktop/native-worker.ts`: optional NativeWritebackHooks; finish() stops the worker, confirms process exit, captures proposals, persists before scratch removal. close() remains discard-only for cancellation/error. Existing unconfigured callers still discard temporary changes.
- `apps/engine/src/desktop/native-writeback/capture.ts`: NativeBaseline, NativeWritebackBundle, ProposedFile, BeforeFile, ParentIdentity; captureNativeBaseline, captureNativeChanges, allowedTextPath, digest.
- `apps/engine/src/desktop/native-writeback/outbox.ts`: retainNativeWriteback, acknowledgeNativeWriteback, recoverNativeWritebackOutbox. Private, pinned, no-link, no-replace durable engine outbox.
- `apps/engine/src/desktop/native-writeback/client.ts`: persistNativeWriteback (retain + authenticated send + acknowledge), sendNativeWriteback (send only, for outbox recovery).
- `apps/engine/src/desktop/native-writeback/capture.test.ts`: authored temporary-fixture capture/identity/deletion/link/new-directory confinement regression source.
- `apps/ui/lib/desktop/server/native-writeback/service.ts`: nativeWritebackSchema, nativeBundle, NativeBundle, NativeReview, WritebackAuthority, nativeWritebackService(capture/list/decide).
- `apps/ui/lib/desktop/server/native-writeback/api.ts`: nativeWritebackApi with separate engine capture and desktop user review adapters.
- `apps/ui/lib/desktop/server/native-writeback/service.test.ts`: authored durable restart/digest/one-apply/reject/revocation/source-drift regressions.
- `apps/ui/components/desktop/DesktopNativeWritebackReview.tsx`: self-contained owner-keyed review, explicit current per-file receipts, pagination, Refresh and exact captured-byte decisions.
- This document.

## Identity and state contract

The existing worker copies only allowed visible workspace text into fresh scratch files without links. Before any worker starts, the optional capture path compares each eligible copied .txt/.md against a complete source read, retaining SHA-256, dev:inode, uid/link-count/size/mtime/ctime version and original directory identities. It does not inspect the worker's private state/config directory. Only visible .txt/.md paths in that copied workspace are candidates. The scratch tree remains editable; its baseline is held privately outside that tree, inaccessible to the worker. Proposed bytes are captured only after owned worker exit, before cleanup. Native worker Seatbelt/fork restrictions remain unchanged.

Baseline documents <=32 KiB, after documents <=64 KiB, <=64 eligible files, <=32 scanned folders, bounded depth/512 inspected entries and <=2 MiB proposed before+after content. Capture refuses moving/linked/non-owned/non-UTF8/control/binary files. Removed files produce no proposal and no deletion. New text files are eligible only under directories already present in the copied snapshot and still matching the original directory identities; no directory creation is propagated. Other file types, hidden entries, symlinks, hardlinks and outside-worker configuration are never retained in proposals. An oversized or unstable capture fails rather than publishing a partial file.

The outbox stores immutable JSON under `<engine data>/desktop-native-writeback-outbox`, mode 0700/0600, with no replacement of an existing capture identity, fsync and pinned directories. Authenticated callback acknowledges the exact capture ID only after a SQLite transaction preserves immutable proposal/per-file payloads and digests. A lost callback acknowledgement leaves the engine outbox for exact-ID recovery. A failed capture/stop does not write originals; if worker exit cannot be confirmed, scratch is retained and close fails. A failure before an outbox item has been durably published cannot be claimed as a recovered proposal. Once in the outbox or UI DB, proposals survive restart; no automatic expiry deletes a pending review. Root owns retention/deletion policy. Outbox cap 128 entries, 3 MiB/item; full storage fails closed. Partial hidden outbox temp files are not interpreted as proposals.

Per-file states: pending → rejected, or pending → claimed → saved/conflict/unknown. Decisions include exact proposal ID, relative path and immutable per-file SHA-256 digest. A later changed payload cannot reuse the same capture identity. Concurrent decisions atomically claim the pending row once. Claimed on restart means acknowledgement unknown, never an instruction to retry a save. A saved receipt can be read again; application is not repeated. Before apply, current private source SHA/version/inode and parent identities must equal the reviewed before state. The actual current private save snapshot is passed into existing saveCoworkerFile, preserving its race checks/recovery. Creation uses importCoworkerFile with no replacement and existingDirectoryOnly. Drift never overwrites newer source bytes. Publication failures can remain unknown rather than guessing saved/refused. Reject does not invoke either filesystem publisher. Cancel/close merely discards scratch; originals are unchanged. There is no multi-file atomic transaction or filesystem/SQLite distributed commit.

Review pages use durable file-row cursors, max 64 files and 3 MiB/page, with explicit Load older file changes. No pending proposal is inferred absent because it is beyond a truncated page.

## Mandatory root fragments before activation

Root owns contracts/grants, engine runtime/loop.ts, DesktopConversation, database/bootstrap, route admission and packaging. None was edited. The optional worker hook is dormant until root configures it.

### Separate current permission and exact owner/run authority

Add default-off `nativeWriteback` to root's saved per-coworker grants. It is separate from native temporary workspaceWrite, privateFileWrite, shell and generic approvals. Both a live enabled/current nativeWriteback grant and this dedicated exact-file review are required at publication; Approve does not set or widen any grant. Capture must validate exact local/engine/session/run identity, current native copy/edit/read authorization and current opt-in. Read/reject may remain available for retained proposals when publication is disabled; apply must reject disabled/deleting/reassigned owners and current missing grants. After a run ends, review may apply a retained proposal under current authority; do not require the old model process to remain alive.

```ts
import {nativeWritebackService, nativeWritebackSchema} from '@/lib/desktop/server/native-writeback/service'
import {nativeWritebackApi} from '@/lib/desktop/server/native-writeback/api'
// Root adds a NEW numbered additive DB migration for existing and new installations:
// await db.executeMultiple(nativeWritebackSchema)
const service = nativeWritebackService(db, async(identity, action, signal) => {
  const current = await authorizeExactNativeWriteback(identity, action, signal)
  // REQUIRED root function: exact owner + trusted historical run/session, current enabled,
  // nativeWriteback opt-in, deletion/assignment guard and canonical private workspace mapping.
  // apply additionally requires the current live publication grant at EACH invocation.
  return {owner:current.desktopAgentId, runtime:current.runtime, workspaceRoot:current.privateRoot}
})
const api = nativeWritebackApi(service)
```

The root callback must perform read-only authority checks without taking the roster mutation lock already held by the file publisher. It must honor cancellation and fail closed on unknown/transitioning identity/grants. Root must close admission and make revocation/disable/delete visible before pending publication guards can return. The proposal's historical identity is not permission. A trusted engine capture callback must not accept model-created arbitrary paths as a capture source.

### Authenticated narrow routes

Root registers:
- POST `/api/desktop/engine/native-writeback` → api.capture(request), existing authenticateDesktopEngineRequest.
- GET/POST `/api/desktop/coworkers/[agentId]/native-writeback` → api.review(request,localAgentId), existing authenticateDesktopRequest.

```ts
// Separate root-owned route wrappers:
export const runtime='nodejs'
export const dynamic='force-dynamic'
// engine route:
export async function POST(request:Request){return getNativeWritebackService().api.capture(request)}
// coworker route instead exports GET/POST of this handle:
async function handle(request:Request, context:{params:Promise<{agentId:string}>}) {
  return getNativeWritebackService().api.review(request,(await context.params).agentId)
}
```

GET optional cursor is an immutable file-row cursor. POST `{proposalId,path,digest,decision:'apply'|'reject'}`. Engine capture <=3 MiB/30s, review decision <=4 KiB/30s. Root policy allows only those exact paths/methods with current local identity; no generic file-write callback or permission approval route. Do not append captured texts to system instructions or tool history as commands.

### Runtime/loop.ts: configure before worker creation, finish after model stop

```ts
import {persistNativeWriteback, sendNativeWriteback} from '../desktop/native-writeback/client.js'
import {recoverNativeWritebackOutbox} from '../desktop/native-writeback/outbox.js'
// At supervised startup AFTER authority/callback/database initialization, BEFORE new admissions:
await recoverNativeWritebackOutbox(bundle => sendNativeWriteback(bundle, startupSignal))
// Root migration also records the new additive engine outbox directory; do not edit shipped steps.
// Existing createDesktopNativeWorker site:
nativeWorker = await createDesktopNativeWorker(ctx, {
  authorizeCapture: currentCtx => requireCurrentNativeWritebackCapture(currentCtx),
  persist: bundle => persistNativeWriteback(bundle, captureSignal),
})
// Existing close path: closeModel exits FIRST. Only a successful, authorized normal completion
// may finish; cancelled/failed runs close() and discard. Do this BEFORE endDesktopCodexRun.
try { await closeModel() }
finally {
  if (completedNormally && !ctx.abortSignal?.aborted) await nativeWorker?.finish()
  else await nativeWorker?.close()
}
endDesktopCodexRun(agent.id, run.id)
```

`completedNormally`, `captureSignal`, `startupSignal`, `requireCurrentNativeWritebackCapture` are typed root-owned lifecycle bindings, not lane exports. captureSignal must have an app/Quit cancellation boundary; callback retries use the SAME immutable bundle. Recovery calls sendNativeWriteback, not persistNativeWriteback, so it does not recreate/delete an outbox item twice. Surface persistence errors truthfully; never report a save or proposal acknowledgement from failed finish(). Root must drain capture/persistence before deletion/teardown and must not start capture while native children are still alive. The original loop remains discard-only until root integrates this fragment.

### DesktopConversation

```tsx
<DesktopNativeWritebackReview agentId={currentLocalCoworkerId}/>
```

Use the existing conversation's scroll/history area and owner identity. This is a dedicated review operation; do not route generic request_approval decisions into it. On restart render pending proposals from the durable API even when the original run is over. After unknown acknowledgement refresh the receipt; never resubmit under a new proposal ID. The reusable original approval card handles decision language/layout; the server binds each decision to exact bytes and independently checks permission.

## Dependencies and remaining limits

Only existing Node, zod, @libsql/client, React and @rerun/ui components. No new packages. No central source, live credentials/data, installed app or other lane changed. Outbox recovery must be wired before scratch scavenging/new workers, and retained DB proposals need root history entry/UI wiring. Review does not run a shell, replay a native worker or authorize future bytes. Multi-file proposals apply per file, with visible independent results. Unknown receipts require inspection/reconciliation; there is no automatic retry that can repeat a publication. No activation or native acceptance is claimed.

**No tests, type checks, lint, builds, packaging, installation, app execution, live model/network requests or Mac/restart QA were run by this lane. Root execution/native acceptance is pending.** Root must execute authored regressions and native Stop/Quit/exit, stale source/version/inode, lost capture acknowledgement/restart, reject/concurrent apply and root-grant integration cases before activation.
