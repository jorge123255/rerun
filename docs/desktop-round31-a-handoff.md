# Round 31 A — persistent coworker calls

Historical author handoff. Root repairs and current source status are recorded in [desktop-round31-a-root-review.md](desktop-round31-a-root-review.md); those supersede affected integration/Stop/recovery notes below.

Source handoff only. Checks, typecheck, lint, build, and native acceptance were not run. This is not product acceptance.

Original pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

`apps/ui/node_modules/next/dist/docs` is not installed. The route follows `apps/ui/app/api/desktop/sessions/[sessionId]/questions/route.ts` (`dynamic = 'force-dynamic'`, `params` as a Promise, `desktopRoute`). `apps/ui/package.json` declares Next 16.2.6. UI guidance is `apps/ui/AGENTS.md` and `apps/ui/CLAUDE.md`.

## Original behavior reused

- `apps/engine/src/tools/builtin/call-agent.ts` — tool name `call_agent`, description, `wait` default false, dispatch sentence, prompt `context\n\n---\n\nmessage`, title `from ${caller}: ${message.slice(0, 80)}`, session source `agent` with origin ids, `agent.session.created` before the run, `agent.message.completed` when start fails, self-improvement off only on a clone, callee keeps its own model and `tools.callAgent`.
- `apps/engine/src/tools/builtin/sub-run-watch.ts` — `followSubRun` is not reimplemented. Idle timeout stays 15 minutes. Preview window 600. Recent calls 8. Parent abort text is `(error calling ${name}: ${renderSubRunOutcome(...)})`. With no tools and no partial text that is `(error calling Bob: (stopped: stopped along with the calling run))`, the same string as `call-agent.gaps.test.ts`.
- `apps/engine/src/runtime/headless-run.ts` — used as-is. On this branch it already differs from the pin by the desktop schedule lifecycle hook. `beforeLaunch` / `assertActive` are the last grant and Stop gates. A does not edit this file.
- `packages/contracts/src/chat-sub-runs.ts` — stream part type stays `data-call-agent`.
- There is no `CallAgentBlock` export. The original progress UI is `apps/ui/components/chat/SubRunBlock.tsx`, `apps/ui/components/chat/SubRunTree.tsx`, and `apps/ui/lib/chat/sub-run-progress.ts` (`kind: 'call-agent'`, dispatched headline `Message sent to ${name}`). B adapts those. A does not port them and does not change their layout.

## What this lane owns

- `packages/contracts/src/desktop-coworker-calls.ts` is the only `DesktopCoworkerCallSnapshot` and `DesktopCoworkerCallTarget`.
- Engine factory, tool, memory store, and webhook client: `apps/engine/src/desktop/coworker-calls/**`.
- UI sqlite, authority, read/Stop, and webhook ops: `apps/ui/lib/desktop/server/coworker-calls/**`.
- `GET` and `POST` `/api/desktop/sessions/[sessionId]/coworker-calls`.

Ephemeral `delegate_tasks` is not implemented.

The first `data-call-agent` write is synchronous, before any await, and is only `{ agentName, status: 'queued', steps: 0, toolCalls: 0, failures: 0, preview: '', calls: [] }`. It is not a snapshot. Later parts are the public snapshot plus `agentName: targetName`. They do not include an engine session id. B should prefer `GET`. A closed stream is not completion.

`GET` returns `{ calls: Snapshot[] }` with `cache-control: no-store`. `POST` accepts only `{ operation: 'stop', requestId, callId, expectedRevision }` and returns `{ call: Snapshot }`. Stop affects only that child of that parent session. A wrong session is 404 `Coworker call not found.` A reused `requestId` for a different call or revision is 409. The same `requestId` and body returns the stored response. A 503 does not store a receipt. A 409 does, so the next Stop needs a new `requestId`.

## Root integration

Do not treat the feature as live until these edits land. A did not edit these files.

1. `packages/contracts/src/index.ts`: `export * from './desktop-coworker-calls.js'`. Rebuild `@rerun/contracts` before the engine typecheck. Engine modules value-import `@rerun/contracts`. A relative import would widen the engine `rootDir`. UI code imports the `.ts` source until that export exists. B and C should do the same. Do not copy the types.

2. `apps/ui/lib/desktop/server/database.ts`, in `initialize`, before `return client`:

```ts
await initializeDesktopCoworkerCalls(client)
```

Import it from `./coworker-calls/db`. The feature paths also call it. The root call creates the tables before the first request.

3. `apps/ui/lib/desktop/server/engine-callback.ts`, after the schedule bridge and before created-event handling:

```ts
const coworker = await handleDesktopCoworkerCallBridge(runtime, body)
if (coworker) return coworker
```

Import `handleDesktopCoworkerCallBridge` from `./coworker-calls/http`. The callback is already authenticated. The handler does not take the request signal. Authority uses its own 5 second timeout. No `desktopRouteAllowed` change. No new engine route.

4. `apps/engine/src/cli/commands/desktop-run.ts`, next to `bindDesktopSchedules`, before `ready`:

```ts
const coworkerCalls = await bindDesktopCoworkerCalls(runtime)
```

Import `bindDesktopCoworkerCalls` from `../../desktop/coworker-calls/bind.js`. There is no `close`. This adopt is what marks pre-death active rows `interrupted`. A `GET` before this bind does not invent that status.

5. `apps/engine/src/tools/registry.ts`, only inside the `desktopApp()` branch, after the desktop tool object exists and before it is returned. Do not register hosted `callAgentTools` there. Leave the non-desktop `cfg.callAgent && ctx.callTargets` branch alone.

```ts
const coworkerCalls = readDesktopCoworkerCallRuntime()
if (ctx.agent.config.tools.desktopToolGrants?.callAgent === true && coworkerCalls) {
    Object.assign(tools, desktopCallAgentTools(ctx, coworkerCalls))
}
```

`readDesktopCoworkerCallRuntime` is only the instance `bindDesktopCoworkerCalls` stored. It is not a second authority. Prefer that instance if `buildTools` gains a parameter. Do not construct another runtime. Do not treat hosted `tools.callAgent` or `ctx.callTargets` as the grant.

6. `callAgent` is in the tool catalog as `pending(...)` and is not in `desktopRerunGrantIds`. `desktopRerunGrantsOf(...).callAgent` does not typecheck today. Authority and the registry fragment read `desktopToolGrants.callAgent === true`. Add `'callAgent'` to `desktopRerunGrantIds` before a validated save can persist it. Leave the catalog `available: false` until Settings can edit the allow-list. An empty allow-list means nobody is callable.

7. Settings and C's roster, when root wires them. A has no Control Center UI.

```ts
await replaceDesktopCoworkerCallAllows(db, callerAgentId, targetAgentIds)
const targets = await listDesktopCoworkerCallTargets(db, callerAgentId, grantOn)
```

`listDesktopCoworkerCallTargets` is public. `handle` is always null. There is no handle column. `boxName` is `desktop_spaces.name` through `desktop_space_placements`, or null. `callable` is grant and allow-list and enabled and not deleting. C imports the target type from the contract source. Root injects this list. A does not edit C.

8. Child attention uses the existing question, approval, and takeover scan because `adopt-session` calls `createDesktopSession`. Do not edit `attention.ts`. `suggest_service`, `request_secret`, and `request_mcp_sign_in` show up in that chat and are not new attention kinds.

Authority reads the live engine, fail closed:

- `GET /agents/:id` → `{ id, config: { enabled, tools: { desktopToolGrants } } }`
- `GET /agents/:id/sessions/:sid` → `{ id, agentId }`
- `GET /agents/:id/runs/:rid` → `{ id, agentId, sessionId, status }` and `status === 'running'`

Stop posts `POST /agents/:id/runs/:rid/cancel` for the stored child run only. If the child session exists and the run id is not saved, it `GET`s `/agents/:id/runs?session=` and cancels the one running run on that session. Zero running runs is a local cancel. More than one, or a failed read, is 503 and does not choose. 404 from cancel becomes `interrupted`. 503 clears `stopRequestId`, does not write a receipt, and leaves the status unchanged.

## Durable behavior

Rows live in the UI sqlite database (`desktop_coworker_calls`, `desktop_coworker_call_stops`, `desktop_coworker_call_allows`, `desktop_coworker_call_epoch`). The engine store is the webhook `desktop.coworker-call` with ops `adopt-epoch`, `authorize`, `adopt-session`, `get-by-source`, `get`, `list`, `inbound`, `insert`, `claim`, and `patch`.

A call is created only by the desktop `call_agent` tool. The source key is `JSON.stringify([engineAgentId, engineSessionId, engineRunId, toolCallId])`. The reservation is inserted before `createSession` and `startHeadlessRun`. The same process shares one inflight promise for that key. A second claim does not open another session. A terminal or already launched row is returned and not started again. A same-epoch unclaimed `reserved` row continues the stored target. It does not resolve the name again.

`bindDesktopCoworkerCalls` mints one epoch and adopts it. Active rows whose launch epoch differs become `interrupted` with `The coworker call was interrupted and was not restarted.` They are not started again. The public parent run id is a uuid. Later calls of the same engine run reuse the first row's public parent run id. Engine ids stay on the server row and on the authenticated webhook. `GET` parses the strict public snapshot, so an engine field cannot pass.

Revision increments only when `status` changes. Progress can move under the same revision. Stop's `expectedRevision` still matches during that progress. `wait: true` passes the parent abort signal into `followSubRun`, which cancels the child. `wait: false` does not. That dispatched child keeps its own lifecycle. UI Stop is a separate cancel of the named child.

Named limits, refused whole rather than clipped: message 16384, context 8192, name 200, title window 80, result 32768, depth 3 (depths 0–2 may call), fanout 8 per parent engine run including later failures. Preview is the last 600 characters. Progress keeps 8 calls. A progress tool label uses the 120-character schema window. `DESKTOP_COWORKER_CALL_REPLAY_WAIT_MS` is 30000 and is not a waiter. Cross-process replay returns the stored row immediately.

Duplicate names are refused with the public ids, including when only one is callable. An `@mention` is not a grant and is not stripped. A disabled target is `Coworker "${name}" is switched off and cannot be called.` A resolved target that is not allowed is `Coworker "${name}" is not allowed for this coworker.` A loop is `Coworker calls cannot loop back to ${name}.` A missing `runId`, deleted owner, disabled owner, stale session, or run that is not `running` is `This run can no longer call a coworker.` The grant being off is `Call coworkers is turned off for this coworker.`

The target prompt is only the tool context and message. The callee clone sets `selfImprovement.enabled` false and does not mutate the loaded agent. Secrets matching a bearer/token/key/secret/password/api-key assignment, or an `sk-` token, are redacted in the preview and in the text returned to the caller. The prompt is not rewritten.

## Unsupported and unverified

- No test, typecheck, lint, build, server, or Mac UI was executed. Engine regression sources import `@rerun/contracts` and will not load until item 1 is exported and rebuilt. UI regression sources import the contract source file.
- `handle` is always null.
- No Settings screen writes the grant or `replaceDesktopCoworkerCallAllows`.
- `callAgent` cannot be persisted by the current grant schema until root adds the id.
- `GET` does not mark a dead process's calls `interrupted` until bind adopts a new epoch.
- A crash after `createSession` and before the `session-open` patch can leave an engine session with no desktop row. The reservation is not started again. The next epoch marks it `interrupted` if it is still active.
- After `startHeadlessRun` has passed `assertActive`, turning the grant off does not cancel the child. Stop still can.
- A same-process epoch change is not a normal path. Restart is a new process, so the old run dies with it. Adopt does not send cancel requests of its own.
- `suggest_service`, `request_secret`, and `request_mcp_sign_in` are not new attention kinds.
- Two calls that reserve before either insert is visible can briefly mint two public parent run ids. The insert transaction reuses the first stored id once a sibling row exists.
- The target receives the tool's message and context as written, including anything the model put there. Redaction applies to the caller-visible result and preview.
