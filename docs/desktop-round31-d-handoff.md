# Round 31 D — isolated delegation source handoff

Base: `136f318e931a4433ea6d178f3f9e961e1a2d8a86`.
Branch: `desktop/round31-delegation`.
Original inspected with `git show a6d63a4b542674ddd002e51b39ba0df6e0807bcc:<path>`:

- `apps/engine/src/tools/builtin/delegate.ts`: `delegate_tasks`, four workers, queued/running/settled tasks, title fallback, explicit task/context, ordered `## Task N` results, parent cancellation, drain before ephemeral cleanup.
- `apps/engine/src/tools/builtin/sub-run-watch.ts`: cancellation ownership, recent eight calls, 600-character tail preview, step/failure progress, stop/error distinction, bounded watcher lifetime.
- Current `packages/contracts/src/chat-sub-runs.ts`: reused `SubRunTask` status/call types. Existing UI lane imports this lane's canonical contract; no parallel UI protocol.

Read root CLAUDE.md, apps/ui AGENTS.md/CLAUDE.md and the entire round31 agreement. Installed Next guides were absent at lane node_modules paths and the checked root install paths. No dependencies installed to recover them. No UI component authored; route adapter uses asynchronous params. Root should verify installed-version conventions when mounting.

## Changed files

- `packages/contracts/src/desktop-delegation.ts`
- `apps/engine/src/desktop/delegation/types.ts`
- `apps/engine/src/desktop/delegation/runtime.ts`
- `apps/engine/src/desktop/delegation/tools.ts`
- `apps/engine/src/desktop/delegation/runtime.test.ts`
- `apps/ui/lib/desktop/server/delegation/store.ts`
- `apps/ui/lib/desktop/server/delegation/api.ts`
- `apps/ui/app/api/desktop/sessions/[sessionId]/delegation/handlers.ts`
- `docs/desktop-round31-d-handoff.md`

## Mac adaptations

The original cloned config, soul and keys, enabled shared writes and created global engine agents. This adapter never accepts these objects. Root injects an existing provider/runtime host with exact parent authority and a fresh resource. It passes only explicit task/context, pinned model and certified tool names. Original shared-write widening is removed. Tools matching delegation/calls/human requests/approval/secrets/setup/routines/install/publish/native/shell/browser/computer/MCP/services are refused even if a host mistakenly certifies them. Other tools require host certification AND both original and current parent authorization. Tool checks must be installed in the actual child dispatch path, including native provider bridges; merely filtering model tool descriptions is insufficient.

Original unconditional recursive rm is replaced with opaque token + identity recovery, drain and identity-checked cleanup. No path supplied by a model is removed. Caller-visible outcomes pass root's publicText policy; raw errors and tool arguments are never persisted. This adapter has no environment/key/history/file copying and no hosted authority.

## Root wiring (required, not activated here)

Export the contract from central packages/contracts exports after review:

```ts
export type { DesktopDelegationTask, DesktopDelegationSnapshot,
    DesktopDelegationInput, DesktopDelegationStop } from './desktop-delegation.js'
```

Append both `delegationMigrationSql` statements as a NEW numbered central SQLite migration, with the central previous-version migration regression. Do not execute DDL in request handlers. Both tables contain local metadata/outcomes only, not private engine identities or credentials. Root's publicText implementation must redact any private identifiers/provider diagnostics before persistence; explicit user task text can contain sensitive material, so the host must enforce its existing prompt and output policy.

Construct one authority-owned runtime through existing IPC/provider authority; the engine and UI must address the SAME instance, not create independent runtimes. The store/types have no independent engine or provider implementation. If the engine and UI are separate processes, expose these exact typed operations through existing authenticated IPC (execute/list/stop/reconcile/shutdown), preserving trusted source IDs; do not serialize the host callbacks or allow browser callers to invoke execute. Root must adapt IPC proxy typing where the direct-instance signatures are used.

```ts
const runtime = createDelegationRuntime(
    delegationStore(db), delegationHost, delegationReceipts(db),
)
await runtime.reconcile() // before tool/route admission, once per process generation
// Inside current trusted parent tool construction only:
const tools = desktopDelegationTools(runtime, {
    parentAgentId: publicAgentId, parentSessionId: publicSessionId,
    parentRunId: publicRunId,
}, parentAbortSignal)
// Merge only under default-off delegation grant. Register delegate_tasks as a
// real desktop adapter in native bridge policy; never enable upstream delegateTools.
```

`delegationHost satisfies DelegationHost` from `types.ts` must implement:

- `current`: authoritative public agent/session/run/tool invocation mapping, enabled owner, active parent run, separate saved delegation grant, depth zero and exact resolved model. Return actual current turn tool names, no secret-bearing config. Refuse tools unsafe under current Mac isolation. Deleted/disabled owner or revoked grant must invalidate active children, not only subsequent calls: abort parent scope through existing lifecycle hooks.
- `isolatedTool`: explicit conservative allowlist. Unknown tool families fail closed. Shared output writes, if supported, use existing exact owner/shared-output admission without expanding grants. Ordinary child files remain ephemeral. No private histories, memories, credentials or inherited workspace snapshots.
- `allocate`: reserve ownership durably under source/task ID BEFORE creating a resource. An allocation that fails halfway must remain discoverable by `recover`. Fresh isolated workspace, no credential/config copying. Return opaque token and immutable identity; never a guessed directory path.
- `create`: existing Mac provider authority, parent pinned model and brokered provider credential use ONLY (no credential material enters child workspace/context/env). Enforce authorizeTool before every real tool effect and signal before/after startup. Child cannot reach fallback upstream registries. `run` is single-shot and calls progress serially with backpressure. It MUST reject/settle on cancellation/deadline; `stop` is idempotent and stops all owned native writers. `settled` resolves only after draining tools/processes. A hung noncompliant host cannot be made bounded by this adapter without lying about cleanup; admission must refuse that host.
- `recover`: lookup exact durable source/task allocation even if process died between allocation and record save. Return null only with proof no such allocation exists. Replacement inode/generation mismatch must refuse. This closes the allocation-before-save crash window.
- `drain` / `cleanup`: idempotent exact token+identity operations; confirm child/native process exit BEFORE deleting only exact ephemeral resources. Preserve replacement/user directories and approved shared outputs. Throw on uncertainty. Failed cleanup is durable `blocked`, retryable via Stop/restart.
- `publicText`: existing redaction/public-identity projection, synchronous and bounded; must never return native engine IDs, credential strings or private provider diagnostics.

Canonical route mount in root's route.ts:

```ts
const handlers = delegationHandlers(runtime, authorizeDelegationSession)
export const GET = handlers.GET
export const POST = handlers.POST
```

Mount ONLY `/api/desktop/sessions/[sessionId]/delegation`. GET returns `{delegations: DesktopDelegationSnapshot[]}`. POST accepts exact `{operation:'stop-task',requestId,delegationId,taskId,expectedRevision}` and returns `{delegation}`. UUID request/revision/task IDs; session ID is local public identity. `authorizeDelegationSession` authenticates local user, same-origin/CSRF for Stop, current session ownership and enabled owner; Stop may drain an ended parent run and must never target another run. API revalidates after bounded body read. Unknown fields/operations reject. Stop failures use 409 with retry text; no success placeholder. E should refresh on revision conflict and use a NEW request ID after refresh. An acknowledged identical request replays its sealed receipt; request ID reuse with different input refuses.

Stop checks ownership and expected revision, marks only named task, aborts/drains its lifecycle, then records receipt. Parent abort propagates to all active workers and marks not-started tasks stopped without launching them. For Quit, disable, deletion, or shutdown call and await `runtime.shutdown()` through root's lifecycle before tearing down stores/provider authority. That instance cannot admit work again. Parent AbortSignal must be wired to every parent Stop path.

## Durability and limits

Unique source reservation is `(public agent, session, run, toolCallId)`; SHA-256 input identity rejects changed replay. Tasks/results remain input-ordered. Stores use revision-CAS; one injected runtime serializes internal progress edits. Startup requires reconciliation; queued/running tasks become honest interrupted errors, never execute again. Recovery drains/checks exact ownership before cleanup; cleanup completion is persisted. A possibly executed invocation replays saved state and never dispatches again. Stop receipts persist independently; crash before receipt can return revision conflict, requiring fresh read/retry, without replaying work.

Explicit bounds: four workers, one executing delegation per injected runtime, 32 tasks, 32k characters task+context each, 64k returned bytes per task, 600-character preview, eight recent calls, fifteen-minute task lifetime including startup. One active delegation is a conservative desktop limitation that prevents concurrent calls multiplying the four-worker ceiling; additional calls fail explicitly rather than silently queue. Root must ensure one runtime across admission scopes. The 15-minute total deadline replaces upstream sliding idle timer; no live heartbeat/elapsed timing is fabricated after restart. Call summaries are empty deliberately, retaining tool name/failure without copying potentially secret tool arguments. Partial preview survives failure; full partial result is not claimed.

No arbitrary native/shell/browser/MCP/service child tools, recursive delegation, persistent calls, user requests, setup/routine/install/publish tools. No automatic artifact publishing or file result cards: root's existing confined shared-output authority is required. No migration/bootstrap, actual provider factory, grant, registry activation, IPC mount, or central route mount edited. These are explicit root dependencies, so the capability remains unavailable until integrated.

Regression sources cover subset refusal, result order/empty/failure rendering, durable invocation replay/conflict, and restart interruption/cleanup without re-execution. They were authored but NOT executed. Root must execute all checks and add cancellation races, four-worker scheduling, partial allocation/restart, revision conflicts, stale owner/grant changes, host startup hangs, process drain failures, exact cleanup identities and receipt retries against real adapters.

**No tests, typecheck, lint, builds, installs, servers, live APIs, Mac UI, Docker, Keychain, push or merge were run. Root execution and native/restart acceptance remain pending. This is source handoff, not capability acceptance.**
