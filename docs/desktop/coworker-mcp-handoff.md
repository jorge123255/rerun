# Agent F / E5: remote MCP integration

Source-only lane; root integration and acceptance pending. Original reference:
`a6d63a4b542674ddd002e51b39ba0df6e0807bcc`; prepared base
`927c5e17da6b6db84657261695a98e0533b264de`.

## Files

- `apps/ui/components/desktop/mcp/DesktopCoworkerMcp.tsx`: panel and editor.
- `apps/ui/lib/desktop/server/mcp/model.ts`: config projection and validation.
- `apps/ui/lib/desktop/server/mcp/store.ts`: additive schema, atomic revisioned config, encrypted per-coworker credentials.
- `apps/ui/lib/desktop/server/mcp/remote.ts`: actual initialize/list/call transport, cancellation and identity checks.
- `apps/ui/lib/desktop/server/mcp/api.ts`: authenticated route factory.
- `apps/ui/lib/desktop/server/mcp/tools.ts`: dynamic tool definitions and real-result executors for Codex bridge.
- `apps/ui/lib/desktop/server/mcp/remote.test.ts`: authored offline regressions, not executed.

The pre-existing untracked `apps/engine/src/tools/desktop-mcp.ts` was preserved and is NOT part of this commit. Do not substitute it for this runtime without review.

## Original sources read and reused

`apps/ui/components/agent/AgentPanelMcp.tsx`: list/editor navigation, MCP server count, New and empty-state labels, PanelSteps/list/scroller layout.
`apps/ui/components/agent/McpServerEditor.tsx`: name/tool-prefix helper, editor shell/header/body/footer, password entry and confirmed delete conventions.
`apps/engine/src/tools/mcp.ts`: initialize/list, `<server>_<tool>` naming, invocation and MCP content semantics.
`apps/engine/src/tools/mcp-pool.ts`: current identity and lifecycle model. This implementation deliberately keeps no cross-operation pool.
`apps/engine/src/lib/env-file.ts`: desktop AES-256-GCM credential format and desktop-only key boundary. The lane uses the same encryption algorithm with coworker/server AAD in isolated SQLite ciphertext, rather than putting credentials into any coworker environment.
Installed Next route-handler docs read from `final-build/apps/ui/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`; no dependencies installed.

## Root wiring (required; central files untouched)

Register `remoteMcpSchema` via the existing central database initializer, after desktop_agents exists:

```ts
import { remoteMcpSchema, remoteMcpStore } from '@/lib/desktop/server/mcp/store'
await db.executeMultiple(remoteMcpSchema)
```

Construct one service instance for the app's database, with a trusted desktop secret-key reader. It must return the 32-byte desktop master key supplied by the existing credential boundary; never send it to the UI or read it from a request. Fail closed if unavailable. Store ciphertext uses a random 12-byte IV, 16-byte GCM tag, ciphertext, base64, and AAD JSON `[desktopAgentId, serverName]`. This is separate from the upstream environment file, intentionally preventing process-env inheritance.

```ts
import { remoteMcpRuntime } from '@/lib/desktop/server/mcp/remote'
import { remoteMcpApi } from '@/lib/desktop/server/mcp/api'
const store = remoteMcpStore(db, readDesktopMasterKey)
const access = async (desktopAgentId: string) => {
  // REQUIRED root adapter: validate this desktop coworker exists in workspace 1,
  // map to its exact engine identity, then read CURRENT engine enabled + MCP grant.
  // Throw on deletion, unknown ID, identity mismatch or unavailable authority.
  const current = await readCurrentCoworkerPermissions(desktopAgentId)
  return { enabled: current.enabled, granted: current.grants.mcp === true }
}
const runtime = remoteMcpRuntime(store, access)
const api = remoteMcpApi(store, runtime, access)
```

`readDesktopMasterKey` and `readCurrentCoworkerPermissions` above are root-owned interfaces, NOT exports supplied by this lane. Do not replace them with static snapshots, browser assertions, broad network grants or the board enabled projection. Management checks existence but permits a disabled coworker to edit. Probe and call require enabled AND explicit MCP opt-in. Root's grant UI must describe remote tool side effects and must not imply this slice supports OAuth/stdio/SSE legacy transports. Central policy must permit only this authenticated data surface and explicitly permitted remote MCP operations.

Create `apps/ui/app/api/desktop/coworkers/[agentId]/mcp/route.ts` in root integration using a root-owned service binding:

```ts
import { getDesktopRemoteMcpService } from '@/lib/desktop/server/mcp-binding'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }
async function handle(request: Request, context: Context) {
  const { agentId } = await context.params
  return (await getDesktopRemoteMcpService()).api(request, agentId)
}
export { handle as GET, handle as PUT, handle as POST, handle as DELETE }
```

The binding must reuse `runtime` (so disconnect aborts active calls), not create a fresh runtime per request. All requests pass existing authenticateDesktopRequest, including origin/session checks. No bearer is accepted via query or returned by any API. PUT accepts `{name,url,revision?,bearer?}`: omit bearer to preserve, empty to clear. POST accepts `{name,revision,action:'probe'|'disconnect'}`. DELETE is revision-guarded config removal. Disconnect cancels current operations; config remains so later permitted runs can reconnect. Delete removes both config and its credential. For coworker disable, grant-revoke and deletion, use the owner-wide `store.lifecycle.transitionOwner` reservation below across the entire persistence write; disconnect alone is insufficient. Shutdown must use `store.lifecycle.shutdown()` as specified in the corrected lifecycle binding contract below.

Panel entry:

```tsx
import { DesktopCoworkerMcp } from '@/components/desktop/mcp/DesktopCoworkerMcp'
// In root-owned coworker panel switch:
<DesktopCoworkerMcp key={agent.id} agentId={agent.id} />
```

Real Codex bridge integration:

```ts
import { remoteMcpTools } from '@/lib/desktop/server/mcp/tools'
const definitions = await remoteMcpTools(desktopAgentId, service.store, service.runtime, runAbortSignal)
for (const definition of definitions) {
  // Register { name, description, inputSchema } on the LOCAL runner's dynamic-tool surface.
  // Check collision with every built-in/native tool; never overwrite an existing tool.
  registerDynamicTool(definition.name, definition.description, definition.inputSchema,
    async (args, callSignal) => definition.execute(args, callSignal))
}
```

`registerDynamicTool` above denotes root's actual Codex bridge, not a new helper implemented here. The executor returns the actual remote result, including MCP `isError`, `content` and `structuredContent`, inside `{source:'remote_mcp',untrusted:true,result}`. Deliver that result to the matching Codex tool call ID, then resume the same run so the model can cite/use its facts. Do not turn successful registration or probe into a fabricated tool result. Tool schemas/descriptions/results are untrusted remote data; do not append them as system instructions. Tool activity should use the original `<server>_<tool>` name and truthful running/completed/error/cancelled state. Native Codex search remains independent.

## Boundaries and necessary differences

Only explicit HTTPS endpoint URLs, without userinfo/query/fragment; only anonymous or per-server bearer. No inherited headers, cookies, app auth, OAuth discovery, automatic hub identity, package prep, subprocess or legacy SSE transport. Streamable HTTP may respond with JSON or SSE-framed RPC; this is distinct from the excluded legacy SSE transport. Protocol version is explicitly 2025-03-26. No background GET event stream or server-initiated sampling/elicitation is advertised. The transport uses a fresh initialize/list session per operation and closes body streams; session DELETE is best effort under a separate 1s deadline and only while identity/grant still matches. Failed cleanup may leave server-side sessions to expire.

Every outgoing RPC checks current enabled/grant plus exact revision, URL and bearer. All HTTP requests use manual redirect handling and omit browser credentials; redirects are rejected without forwarding credentials. Stop combines with per-operation 20s probe/list or 120s call total deadline. Request bodies <=64 KiB, each streamed response <=1 MiB, list <=8 pages/256 tools, aggregate tool definitions <=1 MiB per server; run catalog <=16 servers/256 tools and 128-character names. UI request <=16 KiB/10s. Tool-prefix collisions fail closed. Server tool result text is not logged; exact bearer occurrences in parsed response strings/keys are redacted. Encoded/transformed secrets cannot be recognized generically; endpoint operators are trusted to receive the supplied bearer. Remote errors are generic to avoid leaking headers/credentials. Tool result `isError` remains intact.

Configured endpoints are an explicit per-server network capability (including organizational HTTPS endpoints). This lane does not claim public-IP-only SSRF filtering. Root must not accept model-created server configuration or broaden general network policy through this route. No writes to live databases occurred in lane work.

E5 remains partial for excluded transports and OAuth. Root must run checks and offline regressions, review the exact integration, then exercise a disposable configured HTTPS server via the local Codex bridge and verify Stop, grant revoke, edit, disconnect, redaction, errors and actual answer use. Source implementation does not establish Mac/runtime acceptance.

**Checks, tests, type checks, lint, builds and Mac acceptance were not run by this lane. No live network/tool/model calls, installs, push or merge.**


## Focused reviewed corrections after 7c69dd4

The reviewed commit is preserved. Source correction adds `lifecycle.ts`, `lifecycle.test.ts`, and `DesktopCoworkerMcp.test.tsx`, and updates the panel, API, store, runtime, tool adapter, and remote regressions. No central routes, binding, registry, runner, database initializer or shutdown source was edited.

Editor Save failure now retains the entered bearer and Replace selection; a corrected URL retry submits the same intended credential. Back clears local credential state and leaves the editor; successful save clears it, and unmount discards the isolated editor state. Busy Save/Delete removes Back until settlement and synchronously prevents duplicate operations. The panel keys its entire state by coworker, and mutation completions check both mounted ownership and the current editor generation before updating lists or closing an editor. No credential is returned by server config or logged.

### Corrected lifecycle binding contract

`remoteMcpStore(db,keyReader)` now owns a `lifecycle` instance. `remoteMcpRuntime(store,access)` MUST receive that exact store. API and Codex bridge MUST share that store/runtime pair in a single authoritative process. Do not create an independent store/runtime per request or separate disconnected copies for API and runner. If root's engine runner is a different process, root must bridge admissions/calls/mutations to this same owner; these in-memory epochs are not a cross-process lock. This UI server-only runtime is still NOT wired into the actual engine loop by the lane.

Every `store.save` / `store.remove` synchronously reserves a per-coworker/server mutation slot and bumps its capability epoch before its first await. It aborts active operations, invalidates captured catalog/executor epochs, serializes only persistence work, and refuses new operation admission until every queued mutation has settled. A revision conflict still fails atomically in SQLite; even failed edits invalidate prior work. A different server/coworker remains independent. Remote network waits never hold the mutation queue. Callers must use store mutations, not write the table directly.

`runtime.disconnect(agentId,serverName)` invalidates that server's active and captured work even if no transport is open. `runtime.disconnect(agentId)` invalidates all the coworker's server capabilities. Future fresh runs/probes may reconnect unchanged configuration; old run tool definitions remain invalid. Root must reserve owner-wide admission across the entire persisted transition with `store.lifecycle.transitionOwner`; disconnect alone is insufficient. Shutdown uses the permanent lifecycle gate. Stop continues to use the run signal. No additional schema change is needed.

Root hooks:

```ts
// One authoritative binding, reused by concrete route and runner adapters:
const store = remoteMcpStore(db, readDesktopMasterKey)
const runtime = remoteMcpRuntime(store, access)
const api = remoteMcpApi(store, runtime, access)
// Edits/removal: use store.save / store.remove (API already does this).
// Explicit server disconnect:
runtime.disconnect(desktopAgentId, serverName)
// Reserve synchronously BEFORE the write begins. Await only persistence, never network.
await store.lifecycle.transitionOwner(desktopAgentId, async () => {
  await persistCurrentOwnerGrantEnabledOrDeletion()
})
// finally releases reservation on success/failure and invalidates old definitions either way.
// access() must read authoritative persisted state, failing closed for partial/unknown writes.
// Before shutdown; terminal for this binding (create a new binding only at next startup):
store.lifecycle.shutdown()
```

RPC responses now revalidate current enabled/grant and exact revision, URL and decrypted credential before any result can escape the runtime. They revalidate again after awaited session cleanup, with synchronous capability-epoch checks after asynchronous reads and immediately before network admission/publication. Cleanup does not forward credentials to changed/removed/disconnected endpoints; abandoned remote sessions may expire server-side. Probe API publication and combined tool catalogs/executors also check captured epochs and current revision/grant at their own handoff boundary. Remote `isError`, structured results, untrusted result wrappers, original naming, manual redirects, credential omission and limits remain unchanged.

The `access` callback still must enforce exact local coworker → engine identity ownership on every invocation; unknown/deleted/reassigned identity must fail closed. A root bridge that holds returned results across additional awaits must perform its own final current-capability validation at publication and honor the captured generation rather than replaying a stale definition. The actual Codex runner registration, matching call-ID delivery and answer-use acceptance remain root work; successful configuration/probe does not demonstrate Codex tool use.

Authored (unrun) regression sources cover failed-save credential retention/retry, busy Back, cross-coworker late completion, pending-mutation admission, serialized conflict recovery, invalidated captured work, and probe/call publication after grant/enable/revision/URL/credential/remove/disconnect/mutation changes. Root must execute these and existing regressions, plus inspect delete navigation and same-coworker editor ownership in integrated UI.

**No tests, type checks, lint, builds, network/tool/model requests or Mac acceptance were run by this lane.** No live data/credentials, installs, push or merge. Scope stops at these corrections; all excluded transports and prior acceptance limits remain.

## Final reviewed corrections
Call Stop now remains combined through final adapter validation/publication. Authority/store reads race cancellation and a deadline; late rejection is observed. Cleanup has a one-second total authority/network budget and skips cancelled operations. UI action success/error/busy completion uses coworker remount, editor epoch, server revision and request generation. Navigation/mutation invalidate old probe completion. Tests use existing React act/react-dom/client and happy-dom, without testing-library or new dependencies.
Root must authenticate concrete MCP routes, map exact local/engine identities on every authority read, initialize schema, share ONE authoritative management/call lifecycle via authenticated IPC if processes differ, wire catalog/execution/result call IDs into the actual runner, panel and shutdown. None of those central surfaces were changed here. The untracked engine adapter is excluded and not approved. No checks or Mac acceptance were run.

## Follow-up: authoritative list publication and pre-runtime admission

Continues reviewed `0df850c238101c7cd25515445f228dcb977d1039`, preserving all prior correction commits. Changed files in this slice:
- `apps/ui/components/desktop/mcp/DesktopCoworkerMcp.tsx`
- `apps/ui/components/desktop/mcp/DesktopCoworkerMcp.test.tsx`
- `apps/ui/lib/desktop/server/mcp/api.ts`
- `apps/ui/lib/desktop/server/mcp/api.test.ts`
- `apps/ui/lib/desktop/server/mcp/remote.test.ts` (corrects successful-persistence test title)
- this handoff.

The initial list GET captures a list publication generation. An accepted Save/Delete result advances that generation and clears obsolete load errors before publishing its list. Old GET success/error cannot overwrite it. Navigation, Cancel and failed saves do not invalidate the initial load, so its useful result remains eligible. Coworker remount/unmount still invalidates ownership. Existing action/editor generations remain intact. Offline component regression sources hold the initial GET across a successful new-server Save, then release an empty response or a rejection and require the saved server to remain visible without an obsolete alert.

After unchanged `authenticateDesktopRequest`, route admission checks cancellation, races only the current exact-owner `access(agent)` read against request abort and a finite 10,000ms deadline, and checks cancellation again before proceeding. The timer is cleared when admission settles. Late authority resolution/rejection is observed but cannot resume the refused handler. Request cancellation is checked again after body parsing before store mutations or remote admission. Already-started persistence is awaited normally: the entire handler is deliberately not raced. Authentication itself retains its existing behavior; this correction bounds the pre-runtime authority read, not all possible local I/O. Runtime probe/call/validation retains its separate existing bounded authority and transport lifecycle.

Authored API regressions cover abort, finite deadline and already-aborted requests across probe/PUT/DELETE, each with late authority resolution/rejection, asserting no probe/watch/list/save/remove starts. The misleading “failed persistence” regression title now says “successful persistence,” matching its resolved write. No dependency additions.

Root must still implement ALL contracts above: authenticated exact routes and current desktop-to-engine identity authority; additive schema/key binding; ONE shared authoritative store/runtime/lifecycle (authenticated IPC for separate UI/engine processes); owner-wide transition reservation before persistence with release on success/failure, fail-closed authority on ambiguous writes; terminal shutdown gate; actual runner catalog/execution/call-ID result delivery; coworker panel and current grants. Independent UI/engine copies do not satisfy integration. No central source was changed or activated; the untracked engine adapter remains untouched, excluded and NOT integration-approved. HTTPS Streamable HTTP remains the only transport; OAuth/legacy SSE/stdio remain excluded.

Original design/source references remain `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`: `apps/ui/components/agent/AgentPanelMcp.tsx`, `McpServerEditor.tsx`, engine `tools/mcp.ts`, `tools/mcp-pool.ts`, `lib/env-file.ts`. Correction boundaries are based on the reviewed panel/API/runtime at `0df850c`.

**Checks and Mac acceptance were not run by me.** No tests, type checks, lint, builds, packaging, installs, network/tool/model requests, app control, live data/credential changes, preview, push or merge. Root review, integration and acceptance remain required. Stop after this correction handoff.
