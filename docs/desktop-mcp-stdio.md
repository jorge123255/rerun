# Round 28 E5 — separate local subprocess MCP

Base `15dce4a9dcefeb95b0042d01d8b2afc9bbe5c3f6`, branch `desktop/round28-mcp-stdio`. Source-only handoff; root execution/native acceptance and integration are pending. No capability is marked accepted. No MCP server, subprocess fixture, app server or external service was launched by this lane.

## Original source and necessary Mac differences

Read using git show at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:
- `apps/ui/components/agent/AgentPanelMcp.tsx`: New/list/editor PanelSteps, name-prefixed tool summaries and `stdio · executable/arguments` rendering.
- `apps/ui/components/agent/McpServerEditor.tsx` conventions already reused by current DesktopCoworkerMcp: panel editor shell/header/body/footer, Name helper, Save/Delete and busy navigation ownership.
- `apps/engine/src/tools/mcp-pool.ts`: per-coworker/server connection identity, shared opening promise, 20-second connect, 10-minute idle lifecycle, re-acquisition after close, releaseAgentMcp/closeAllMcp.
- `apps/engine/src/tools/mcp.ts`: stdio transport receives explicit command, argument array, cwd/environment; initialize/list/call and `<server>_<tool>` naming. The Mac implementation uses a small bounded newline JSON-RPC runner so raw output, cancellation and owned process-group termination can be enforced before SDK parsing.

Unlike original agentMcpSpawn/default environment, this path supplies NO agent/provider credentials, inherited process.env, HOME, CODEX_HOME, OAuth bundle, custom environment or remote headers. It has no package preparation, variable expansion, shell command string, npx/npm/uvx download step, SSE or HTTPS transport. Existing remote/OAuth store/schema/runtime/editor files were not edited. Local config is a different table and grant; it cannot convert a remote connection into an executable implicitly.

## Changed files and exports

- `apps/ui/lib/desktop/server/mcp-stdio/store.ts`: stdioInput, StdioConnection, stdioSchema, stdioStore, StdioStore. Isolated local owner-scoped revisioned config and durable call tombstones.
- `apps/ui/lib/desktop/server/mcp-stdio/process.ts`: StdioSpawn, stdioEnvironment, executableIdentity, spawnStdio. Only runner entry used by the authorized runtime.
- `apps/ui/lib/desktop/server/mcp-stdio/runtime.ts`: StdioRun, StdioAuthority, stdioRuntime(store,authorize,spawnProcess?) → probe/tools/disconnect/transitionOwner/shutdown.
- `apps/ui/lib/desktop/server/mcp-stdio/api.ts`: stdioApi, authenticated selected-coworker GET/PUT/DELETE/POST management adapter.
- `apps/ui/lib/desktop/server/mcp-stdio/bridge.ts`: stdioEngineBridge, authenticated exact-run catalog/call/release adapter, opaque catalog/tool capabilities and shutdown/releaseOwner.
- `apps/ui/components/desktop/mcp/DesktopMcpStdioConnection.tsx`: isolated original-style editor, StdioEditorInput, explicit installed executable plus JSON argument array and honest Mac access warning.
- `apps/engine/src/desktop/mcp-stdio/client.ts`: desktopStdioTools(ctx,authorize) → {tools,close}, cancellable bounded authenticated local bridge client for the real runner.
- `apps/ui/lib/desktop/server/mcp-stdio/process.test.ts`: authored injected fake-child/stdout tests for literal argv, allowlisted environment, Stop/group termination and output refusal.
- `apps/ui/lib/desktop/server/mcp-stdio/runtime.test.ts`: authored injected fake-process/SQLite tests for one opening, owner isolation, current grant refusal, unknown-call replay refusal and transition/shutdown invalidation.
- This document.

Only existing Node, React, zod, @libsql/client, ai and current panel primitives are used. No dependencies added. Tests inject fake children and do not require root to select or launch a real server.

## Admission and lifecycle contract

Config is explicit absolute executable plus an array of literal strings. It is saved only for the route's selected local coworker. No path/command is taken from a model tool argument. executableIdentity requires a canonical installed executable, no symlink path, regular executable owned by current Mac user or root, and records dev/inode/size/mtime/ctime for reuse checks. Common shell, env wrapper, package runner, sudo/osascript/open/launchctl executables are refused. This is an application admission rule, NOT an OS sandbox or general malicious-program detector. A renamed shell/interpreter or explicitly configured program can have arbitrary Mac effects; separate consent/grant is essential. Scripts/interpreter arguments are literal user-selected paths/strings, not a promise that referenced files cannot change externally.

spawn receives shell:false, detached:true, exact argv and a fresh allowlisted environment containing only PATH=/usr/bin:/bin, LANG and LC_ALL=en_US.UTF-8. Do not put credentials in arguments: they are ordinary inspectable configuration, not a secret channel. No new secret persistence is added; the existing encrypted remote bearer/OAuth path stays unchanged. A local executable runs as the Mac user and can read Mac resources on its own; these application limits do not confine its filesystem or network access.

One authoritative runtime reserves an opening before its first await, shares it per owner/name/revision, verifies canonical owner cwd, current exact owner/enabled/local grant and configured executable identity before spawn and use, then initializes protocol 2025-03-26 with no server-request capabilities. Startup/list has a 20-second deadline, calls 120 seconds; local HTTP adapters/clients have bounded budgets. Tool lists <=8 pages/256 tools, aggregate definitions <=1 MiB. Request frame <=64 KiB, response frame <=1 MiB, lifetime stdout <=8 MiB and stderr <=64 KiB. Streamed UTF-8/JSON is validated; stderr is drained/counted but never logged, returned or used as model instructions. No server-initiated requests/sampling/elicitation are accepted. MCP content, structuredContent and isError remain actual untrusted results.

Per-process work is serialized; connection idle lifetime is 10 minutes. Stop/deadline invalidates the active process rather than guessing that a timed-out call failed. Config edits/removal synchronously reserve mutation admission, abort active work, await owned process drain, then persist a revision-guarded change. Disconnect invalidates captured definitions and terminates owned process groups, TERM followed by KILL after 500ms, even if the parent already exited. Shutdown permanently closes admission, stops all tracked active/retiring processes and awaits drain. Exit not confirmed within the drain boundary is an error, not a completed shutdown. Old captured capabilities do not reconnect themselves. A new probe/catalog can reconnect a dead idle server after retiring its prior owned group.

Children in the owned process group are terminated with the group. This is not a sandbox: a deliberately daemonizing program that escapes that group is outside this runner's cleanup guarantee. Root must choose a trusted benign fixture/server for acceptance and must provide stronger OS containment before claiming cleanup of arbitrary hostile detached daemons. No such native acceptance is claimed here.

Before an actual tools/call, a durable `(owner,runId,toolCallId,digest)` tombstone is inserted. Duplicate identity refuses forever for that owner/run; reconnect/restart cannot replay it, including after an uncertain response. Re-initialization/tool listing may occur; side-effecting calls are never automatically retried. Tombstones deliberately do not manufacture a success result or restore a lost result. isError is preserved when a real result arrives. Root must retain exact call IDs and report unknown acknowledgement truthfully.

## Required root integration (no central files edited)

### Separate saved permission and schema

Add a distinct saved default-off `localMcpStdio` grant per coworker. Do not infer it from remote MCP/OAuth, network, shell, filesystem or a generic approval response. UI must show the executable/argument array honestly and explain Mac-user resource access. Saving a connection is not permission to spawn it. All use/probe/catalog/call operations need CURRENT enabled state, exact local-to-engine ownership, and this explicit grant. Management may allow a disabled coworker to edit configuration, but must still resolve an extant selected owner and reject deleting/reassigned identities.

Register stdioSchema as a NEW numbered additive desktop DB migration after desktop_agents for both existing and new installations. Enable foreign keys and hide both tables from model-accessible data tools. Root owns receipt retention and permanent coworker deletion; no migration or existing remote schema was edited here.

```ts
import {stdioStore,stdioSchema} from '@/lib/desktop/server/mcp-stdio/store'
import {stdioRuntime,type StdioAuthority} from '@/lib/desktop/server/mcp-stdio/runtime'
import {stdioApi} from '@/lib/desktop/server/mcp-stdio/api'
import {stdioEngineBridge} from '@/lib/desktop/server/mcp-stdio/bridge'
// Root additive numbered migration: await db.executeMultiple(stdioSchema)
const authority:StdioAuthority = async(owner,action,run,signal) => {
  const current = await resolveExactCurrentLocalMcpOwner(owner,run,signal)
  if(action==='use') {
    if(!current.enabled || !current.grants.localMcpStdio) throw new Error('Local MCP is off')
    // If run is supplied, validate its exact engine/session/run and active non-aborted state.
  }
  // Reject deleted/deleting/reassigned/unknown identity for every action.
  return {cwd:current.canonicalPrivateWorkspace}
}
const store=stdioStore(db)
const runtime=stdioRuntime(store,authority) // binds process teardown exactly once to this store
const api=stdioApi(store,runtime,authority)
const bridge=stdioEngineBridge(runtime, async(run,signal,action) => {
  // REQUIRED root identity mapping. catalog/call require current enabled+localMcpStdio and live run.
  // release may validate exact historical owner/session/run after Stop, without granting new use.
  return authorizeExactLocalMcpRun(run,signal,action)
})
```

Root interfaces resolveExactCurrentLocalMcpOwner/authorizeExactLocalMcpRun are contracts, not lane exports. Never accept a model-provided local owner/cwd/grant. ONE store/runtime/bridge pair must own process lifecycle in the supervised UI process. Do not create independent per-request services or a second engine process spawning the same configuration. The engine receives opaque catalog capabilities and descriptors/results, not credentials or authority to configure processes.

### Narrow route policy and wrappers

- GET/PUT/DELETE/POST `/api/desktop/coworkers/[agentId]/mcp-stdio` → api(request,selectedLocalId), existing authenticateDesktopRequest.
- POST `/api/desktop/engine/mcp-stdio` → bridge.api(request), existing authenticateDesktopEngineRequest.

PUT `{name,executable,args,revision?}`; DELETE `{name,revision}`; POST `{name,revision,action:'probe'|'disconnect'}`. Engine requests are exact run identity plus action catalog/call/release; call also carries catalogId/capabilityId/toolCallId/arguments. Management input <=32 KiB/30s; engine input <=64 KiB/125s, bounded tool/call output. Central policy must admit only these authenticated methods/paths; no unrestricted subprocess, shell or wildcard route.

```ts
export const runtime='nodejs'
export const dynamic='force-dynamic'
async function handle(request:Request,context:{params:Promise<{agentId:string}>}) {
  return getAuthoritativeStdioService().api(request,(await context.params).agentId)
}
export {handle as GET,handle as PUT,handle as DELETE,handle as POST}
// Separate engine route exports POST(request) => getAuthoritativeStdioService().bridge.api(request)
```

getAuthoritativeStdioService is root-owned. Routes do not spawn at import/startup; a current authenticated probe or model catalog admission is required.

### Panel and common rendering: additive optional contract only

Keep existing remote/OAuth editor/store untouched. Root's panel switch adds an explicitly labelled Local subprocess option, and keys the editor by selected coworker/server/revision so late completions cannot close another owner's editor:

```tsx
<DesktopMcpStdioConnection key={`${agentId}/${server?.name??'new'}/${server?.revision??''}`}
  server={server} onSave={saveExactLocalDelta} onDelete={deleteExactLocalRevision} onBack={back}/>
```

Save/Delete callbacks must await the scoped stdio API and publish its authoritative list only to the same editor owner/generation. They must not toggle a grant or copy remote secrets. Parent uses the original AgentPanelMcp list/count/New/empty/PanelSteps layout. Common rows may accept an OPTIONAL discriminated contract, without changing remote required fields:

```ts
type LocalMcpRow={transport:'stdio';name:string;revision:string;executable:string;args:string[]}
// Existing remote rows remain their current type; add only an optional local row render path.
const localSummary=(row:LocalMcpRow)=>`stdio · ${JSON.stringify([row.executable,...row.args])}`
```

Do not join arguments into a shell command. Probe results are a completed connection listing, not evidence that a model used a tool. The editor blocks Back during Save/Delete and preserves the draft on failure.

### Real runner registry and lifecycle

```ts
import {desktopStdioTools} from '../desktop/mcp-stdio/client.js'
// Root runtime/loop.ts, only if the current separate grant is on:
const localMcp = await desktopStdioTools(ctx, () => requireCurrentLocalMcpRun(ctx))
for(const [name,definition] of Object.entries(localMcp.tools)) {
  if(tools[name]) throw new Error('MCP tool name collision') // includes remote/built-in/native tools
  tools[name]=definition
}
// Add localMcp.close to existing closeTools teardown, including Stop/error.
```

requireCurrentLocalMcpRun is a root-owned live grant/owner/run check, not a new generic shell permission. Deliver actual result to matching tool-call ID; preserve untrusted wrapper/isError, resume the same run, and never report a cancelled/unknown call as success. After lost acknowledgement keep the same toolCallId and do not mint another ID to bypass its tombstone. close releases the exact catalog using an independent bounded teardown signal so run Stop cannot suppress release.

Root disable/revoke/delete must reserve local admission synchronously for the ENTIRE transition, drain owned processes, and then persist:

```ts
await runtime.transitionOwner(localAgentId, async()=>{
  bridge.releaseOwner(localAgentId)
  await persistCurrentEnabledGrantOrDeletion()
})
```

If the transition also affects remote MCP/OAuth, nest the existing remote owner reservation around this local reservation; do not substitute disconnect for a pending write. Both reservations must precede persisted authority changes and release on success/failure, leaving old definitions invalid. On Quit close HTTP/model admission, then await bridge.shutdown() (terminal gate, catalog cancellation, process drain), before server/process exit. Do not restart the same closed binding. A teardown error must be surfaced as unconfirmed exit; no claim that cleanup completed.

## Remaining limits and validation

No automatically installed packages, user env editing, local credential input or OAuth-to-stdio conversion. Absolute installed canonical executables only; symlink paths and known shell/package runners refuse. A trusted interpreter can run a selected installed server script, but referenced scripts and arbitrary program behavior are not sandboxed. Output and process limits are application bounds, not OS CPU/memory/network confinement. A native stronger containment policy is root packaging work if required for arbitrary untrusted programs. Existing remote/OAuth acceptance is neither changed nor re-established by this source slice.

Root must run authored mock-only regression sources, existing remote/OAuth regressions, type checks/lint/build, API auth/cross-owner/revision tests, cancellation at every authority/claim/RPC await, startup timeout/late child failure/oversized output, disable/delete/Quit process-tree checks and durable tombstone restart tests. Root alone selects a benign installed fixture and performs live listing/call/Stop/disconnect/reconnect/native acceptance. No fixture executable was selected or run here.

**No tests, type checks, lint, builds, packaging, installation, live model/network requests, MCP server launches, live credential access, app control or Mac/restart QA were run by this lane. Root execution/native acceptance is pending.** No other worktree/central remote schema, store, grants, registry, UI, packaging or acceptance checklist was edited. No push or merge.
