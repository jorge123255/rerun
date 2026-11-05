# Round 31 D — bounded ephemeral delegation handoff

Base: `136f318e931a4433ea6d178f3f9e961e1a2d8a86`. Continued the existing `fc573b7092bf48cbe9f4d118e636b858a8510d45` source commit without resetting it.

This is a source handoff, not capability acceptance. Root owns integration, repairs, all checks and native/restart QA.

## Original source mapping

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/engine/src/tools/builtin/delegate.ts`: `delegate_tasks`, four concurrent workers, ordered final `## Task N` results, queued/running/settled states, title fallback, explicit task/context, parent cancellation and partial outcomes.
- `apps/engine/src/tools/builtin/sub-run-watch.ts`: drain/cancellation ownership, 600-character tail preview, recent eight calls, step/tool/failure progress, stop-vs-error handling and bounded watcher lifetime.
- `packages/contracts/src/chat-sub-runs.ts`: `SubRunTask`-compatible status, call and progress shapes.
- `apps/ui/components/chat/SubRunTree.tsx` and `SubRunBlock.tsx`: ordered branch presentation and per-task Stop consumed by E; read only.

The Mac adapter deliberately does not copy the original config/soul/key cloning, automatic `tools.shared=true`, global agent creation, or unconditional recursive removal. The installed Next.js route-handler guide was read for async route context and native Request/Response conventions.

## Exported owned surface

- `packages/contracts/src/desktop-delegation.ts`: `DesktopDelegationTask`, `DesktopDelegationSnapshot`, `DesktopDelegationInput`, `DesktopDelegationStop`.
- `apps/engine/src/desktop/delegation/types.ts`: `Authority`, `Source`, `Resource`, `OwnedOutput`, `DelegationStore`, `ReceiptStore`, `DelegationHost`, `Child`, `ProgressEvent`.
- `apps/engine/src/desktop/delegation/runtime.ts`: `createDelegationRuntime`, `DelegationRuntime`, `subset`, `orderedDelegationResult`, `DELEGATION_LIMITS`.
- `apps/engine/src/desktop/delegation/tools.ts`: `desktopDelegationTools` for one trusted `delegate_tasks` invocation.
- `apps/ui/lib/desktop/server/delegation/store.ts`: `delegationStore`, `delegationReceipts`, `delegationMigrationSql`.
- `apps/ui/lib/desktop/server/delegation/api.ts`: `delegationApi`, `DelegationSessionAuthority`.
- `apps/ui/app/api/desktop/sessions/[sessionId]/delegation/handlers.ts`: `delegationHandlers` for root's route mount.

Task snapshots retain public parent/session/run/tool-call IDs, stable task IDs, revision-CAS state, ordered real progress, bounded preview/calls, results, `partial`, timestamps and cleanup state. Output identities/hashes remain in the internal record, not a new UI protocol.

## Required root integration

Export the contract centrally after review:

```ts
export type {
    DesktopDelegationTask, DesktopDelegationSnapshot,
    DesktopDelegationInput, DesktopDelegationStop,
} from './desktop-delegation.js'
```

Append the two `delegationMigrationSql` statements as a new numbered central SQLite migration with the central previous-version regression. Do not execute DDL in request handlers. Existing JSON records without `outputs` decode as unadmitted output slots for backward compatibility.

Construct one authority-owned runtime and reconcile before tool/route admission:

```ts
const runtime = createDelegationRuntime(
    delegationStore(db),
    delegationHost satisfies DelegationHost,
    delegationReceipts(db),
)
await runtime.reconcile()
```

If engine and UI run in separate processes, root must expose this same runtime through existing authenticated IPC. Do not create independent runtimes, serialize host callbacks, or let browser callers invoke `execute`.

Merge the tool only inside a trusted current parent turn behind the default-off delegation grant:

```ts
const tools = desktopDelegationTools(runtime, {
    parentAgentId: publicAgentId,
    parentSessionId: publicSessionId,
    parentRunId: publicRunId,
}, parentAbortSignal)
```

Root owns grant/catalog/registry activation and must enforce `authorizeTool` in the real child dispatch path, not only in model-visible tool descriptions.

Mount the API:

```ts
const handlers = delegationHandlers(runtime, authorizeDelegationSession)
export const GET = handlers.GET
export const POST = handlers.POST
```

`authorizeDelegationSession` authenticates the local user, same-origin/CSRF for Stop, current session ownership and enabled owner. GET returns `{delegations}`. POST accepts only `{operation:'stop-task',requestId,delegationId,taskId,expectedRevision}` and returns `{delegation}`. Body reads are limited to 4096 bytes and requests to 10 seconds. Stop failures return 409 with retry text. A conflicting request ID never reuses another operation's receipt.

## Host authority requirements

`DelegationHost.current` must validate the exact public agent/session/run/tool invocation, active parent run, enabled owner, depth zero, current delegation grant and exact resolved connection/model. Return current parent-turn tools only. Deleted/disabled owners, revoked grants, stale runs and model changes must refuse execution. Root must propagate parent revocation/Stop to the supplied AbortSignal.

`create` receives only explicit task/context, `connectionId`, `model`, certified tool names, `authorizeTool` and signal. It must use the existing provider runtime without placing credentials, secret configuration, private history, memories or a persistent coworker workspace in the child. Provider startup/run/settlement must honor cancellation. `stop` is idempotent; `settled` finishes only after child tools/processes drain.

`subset` requires both host certification and current parent authorization. Recursive delegation, persistent calls, user questions/approvals/secrets/app requests, setup completion, routines/triggers/schedules/install/publish, native/shell/browser/computer/MCP/service/takeover capabilities fail closed. No implicit shared-write widening exists.

`allocate` must durably reserve a fresh empty isolated resource under source/task ID before provider effects. `recover` must find an allocation even if the process died before record save and reject replacements. `drain` must confirm exact owned writers stop. `admitOutputs` uses the existing grant-checked shared-output authority and returns exact admitted identities/hashes before deletion. `cleanup` receives those outputs and must refuse unknown, changed, symlinked or replacement ownership rather than recursively deleting it. `publicText` applies existing redaction/public-identity policy; raw provider diagnostics and tool arguments are not persisted.

## Persistence, cancellation and errors

- Reservation identity is `(parentAgentId,parentSessionId,parentRunId,toolCallId)` plus SHA-256 input fingerprint. One insert persists the ordered task identities before resources/provider effects. Same-source/same-body concurrent calls join the active invocation; settled replay returns saved state. Changed bodies refuse without another launch.
- Four workers are admitted at most; results remain input ordered. One executing delegation per injected runtime prevents unbounded fanout. Task count is 32, title 200 characters, task+context 32,000 characters, result 64,000 bytes, preview 600 characters, recent calls eight.
- Each task has a 15-minute total lifetime. Host operations have 30-second bounds. Queued tasks remain queued until admitted. Provider absence/start failure/errors produce honest task errors, not successful results.
- Status changes are monotonic. Late progress/results cannot overwrite Stop. Failure counts accumulate; call summaries remain empty to avoid copying potentially secret arguments.
- Individual queued Stop cancels only that task; other queued tasks remain eligible. Parent Stop/shutdown stops active workers and all queued siblings. Valid partial preview is retained as bounded partial result text and marked `partial`.
- Cleanup drains first, admits outputs, persists hashes, then removes only exact resources. Unknown/replaced ownership or failed admission leaves `cleanup:'blocked'`; no broad deletion or success receipt. Retry is available through Stop/restart.
- Stop checks parent ownership/revision, aborts/drains the exact task, and persists a receipt only after confirmed cleanup. Concurrent identical requests join; late identical requests replay the receipt. Request-ID reuse with different input refuses.
- Startup reconciliation marks queued/running work as interrupted errors and never re-executes it. Recovery can drain/admit/clean pre-save allocations without launching workers. Historical GET never creates work.
- `shutdown()` aborts the parent scope, prevents later admission and awaits the active execution before root tears down stores/providers.

## Implemented / dependent / unsupported matrix

| Area | Owned source | Root dependency or unsupported remainder |
| --- | --- | --- |
| Canonical snapshots and tool factory | Implemented | Central contract export and registry/grant activation required |
| Durable ordered reservation and replay | Implemented | Central numbered migration/bootstrap required |
| Four-worker scheduling and ordered results | Implemented | Real provider acceptance required |
| Strict inherited model/tool authority | Interfaces and enforcement implemented | Current Mac authority and certified child dispatch required |
| Real progress and partial outcomes | Implemented | Real provider event mapping required |
| Output ownership and replacement-safe cleanup | Interfaces and lifecycle implemented | Existing shared-output authority and filesystem identity implementation required |
| Individual/parent Stop and receipts | Implemented | Parent AbortSignal and lifecycle wiring required |
| Restart reconciliation and shutdown | Implemented | Process-generation hooks and real restart QA required |
| Authenticated GET/Stop adapters | Implemented | Root route mount and session authority required |
| E presentation | Exact contract supplied | E owns `SubRunTree`/`SubRunBlock` adapter and polling |
| Secret/config/history copying | Not implemented by design | Must remain unsupported |
| Recursive/persistent calls, user requests, broad native/shared grants | Refused by contract/subset | Must remain unsupported |
| Real Codex/provider execution, native cancellation, full restart acceptance | Not run | Root performs all checks and acceptance |

## Regression sources authored and unrun

- `apps/engine/src/desktop/delegation/runtime.test.ts`: subset refusal, ordered outcomes, duplicate replay/conflict, restart drain/cleanup.
- `apps/engine/src/desktop/delegation/runtime.expanded.test.ts`: four-worker concurrency/order, cumulative progress, concurrent duplicate invocation, grant/model revocation, provider startup failure, individual/queued/parent Stop, wrong owner/task/revision, partial output, restart recovery, output-admission/replacement cleanup failures, shutdown, exact child input, input bounds and Stop receipts.
- `apps/ui/lib/desktop/server/delegation/api.test.ts`: authorized history, exact Stop payload, unknown operation, oversized body and ownership changes.

No tests, typecheck, lint, builds, installs, servers, live APIs, Mac UI, Docker, Keychain, push or merge were run. Root execution and native/restart acceptance remain pending.
