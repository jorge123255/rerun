# Round 32 G — legacy SSE MCP source handoff

Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round32-mcp-sse`.
Branch: `desktop/round32-mcp-sse`.
Exact parent/base: `ab0de35eb45fbcf0b801943fd8ad7c3c861b9210`.
Original pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

**Authored source and regression sources only.** No tests, type checks, lint,
builds, installs, servers, packaging, native UI, live API/provider/network calls,
Docker, Keychain, live workspace reads or restart checks were run. No push,
merge, deployment or publication. Root execution, integration and native/full
restart acceptance remain pending; E5 and the checklist are not marked complete.

The checkout was clean at the exact prepared base before editing. No other
worktree, round31 lane, shared MCP implementation, barrel, central registry,
route, schema/bootstrap, provider, permission or existing UI was edited. No
round32 agreement/interface file was present in this checkout when inspected.
`docs/desktop-agent-assignment-standard.md`, applicable supplied AGENTS, root
`CLAUDE.md`, UI `AGENTS.md`/`CLAUDE.md` and installed Next.js `use-client` guidance
were read. Installed guidance used:
`/Users/gszulc/OpenBot/Shared/rerun-desktop/apps/ui/node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md`.

## Changed files

1. `packages/contracts/src/desktop-mcp-sse.ts`
2. `packages/contracts/src/desktop-mcp-sse.test.ts`
3. `apps/ui/lib/desktop/server/mcp-sse/types.ts`
4. `apps/ui/lib/desktop/server/mcp-sse/errors.ts`
5. `apps/ui/lib/desktop/server/mcp-sse/parser.ts`
6. `apps/ui/lib/desktop/server/mcp-sse/endpoint.ts`
7. `apps/ui/lib/desktop/server/mcp-sse/network.ts`
8. `apps/ui/lib/desktop/server/mcp-sse/validation.ts`
9. `apps/ui/lib/desktop/server/mcp-sse/connection.ts`
10. `apps/ui/lib/desktop/server/mcp-sse/runtime.ts`
11. `apps/ui/lib/desktop/server/mcp-sse/adapters.ts`
12. `apps/ui/lib/desktop/server/mcp-sse/parser.test.ts`
13. `apps/ui/lib/desktop/server/mcp-sse/network.test.ts`
14. `apps/ui/lib/desktop/server/mcp-sse/runtime.test.ts`
15. `apps/engine/src/desktop/mcp-sse/normalize.ts`
16. `apps/engine/src/desktop/mcp-sse/normalize.test.ts`
17. `apps/ui/components/desktop/mcp-sse/editor-state.ts`
18. `apps/ui/components/desktop/mcp-sse/DesktopMcpSseEditor.tsx`
19. `apps/ui/components/desktop/mcp-sse/DesktopMcpSseConnection.tsx`
20. `apps/ui/components/desktop/mcp-sse/presentation.test.tsx`
21. `docs/desktop-round32-g-handoff.md`

## Original source/design mapping

Actual source was read with `git show <pin>:<path>`:

| Original | Reused behavior | Mac adaptation |
| --- | --- | --- |
| `apps/engine/src/tools/mcp.ts`: `resolveTransport`, `buildTransport`, `SSEClientTransport`, `openMcpClient`, `probeMcp` | Explicit `sse`; GET event stream, endpoint advertisement and POST JSON-RPC; initialize/initialized/tools/list/tools/call; late-open/failed-probe cleanup | Bounded custom stream adapter avoids SDK EventSource automatic reconnect/auth retry and ambient networking. No HTTP/stdio fallback, hub headers or package preparation. Existing root credential/network boundaries are mandatory. |
| Same file: `mcpToolSet` / `apps/engine/src/tools/mcp-schema.ts` | `<server>_<tool>` names; original root-combinator normalization/constraint notes | New engine `normalizeSseTool` imports the existing `toToolInputSchema`; no copied normalizer. Server injects that behavior, bounds and validates the whole catalog before returning any tools. |
| `apps/engine/src/tools/mcp-pool.ts` | Exact owner/server/config fingerprint, 20-second connect, inflight ownership, idle release, shutdown | Root injects pool state and the existing lifecycle admission. Credential generation is part of the private identity. Failed drains stay retired; possibly executed calls require a durable root claim and are never replayed. |
| `apps/ui/components/agent/McpServerEditor.tsx` | Name, Transport (`stdio`, `sse`, `http`), URL, Headers; original shell/body/footer; managed read-only message; Delete server / Save changes / Create server | Local injected save/auth callbacks only. SSE is the owned editor; other buttons route back to existing root HTTP/stdio editors. Headers remain visible as a label/status but values stay in existing auth settings, with no new secret input, environment editor or hosted actions. Name is immutable after creation. |
| `apps/ui/components/agent/AgentPanelMcp.tsx` | Existing list/edit navigation and per-server controls | Isolated row/editor exports for the existing panel; no parallel registry or panel mount. Root keeps Apps/managed ownership and existing navigation. |
| `apps/ui/components/services/CustomMcpStatusBadge.tsx` | Connected tool count, Sign-in needed, Unreachable tooltip | Same Badge/Skeleton/Tooltip presentation plus truthful unchecked/unsupported/close-unconfirmed states. A temporary probe is explicitly marked `observation: 'probe'`, not a live connection. |

The current Mac `mcp/{model,store,remote,lifecycle,bridge,api}.ts`, `mcp/tools.ts`,
OAuth loopback/network helpers, `mcp-binding.ts`, engine `desktop/mcp-tools.ts`,
current `DesktopCoworkerMcp.tsx`, panel primitives and adjacent stdio lifecycle
were read. They are unchanged. Current `remote.ts` response-SSE decoding remains
a **Streamable HTTP** path; G never sends legacy SSE through it.

The installed official MCP SDK SSE source and supported-version constants were
also read locally. The client proposes `2025-03-26` and accepts the SDK's known
versions `2024-10-07`, `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25`.
No package was installed or version changed.

## One canonical contract

`packages/contracts/src/desktop-mcp-sse.ts` is the sole new contract. It reuses
`mcpServerNameSchema` and a pick of existing `mcpServerSchema` for the settings
delta; it does not replace the MCP configuration schema.

Exports include:

- `DESKTOP_MCP_SSE_LIMITS` and strict ref/request/call/tool/snapshot/outcome schemas.
- `DesktopMcpSseRef`: local `agentId`, immutable `serverId`, immutable `name`,
  `expectedRevision`.
- Control DTO: that ref plus UUID `requestId` and
  `operation: status | connect | probe | disconnect`.
- Call DTO: that ref plus UUID `requestId`, local session/run/tool-call identities,
  tool name and JSON arguments. This DTO is **not authorization**; root supplies
  the authenticated current `McpRunIdentity` separately.
- Public snapshot: that ref, transport `sse`, sanitized HTTPS origin only,
  state, bounded tool metadata, optional observation and fixed failure/message.
- Outcome: request ID, completed/uncertain/refused and result only when completed.
- Public settings delta/save/mutation callback types. They contain no header,
  bearer, OAuth token, engine ID or protocol session token.

`observation: 'probe'` means an actual initialize/list completed and its temporary
stream was confirmed closed before returning. A subsequent status read describes
the root-owned live slot, or unchecked saved configuration after restart. It
never automatically probes to make a badge green.

## Ready-to-wire APIs

Server-only `types.ts` defines required injected dependencies:

```ts
const pool = createSsePoolState() // root retains this in its existing service entry
const network = createPinnedSseNetwork({ resolvePublic, credential })
const sse = createSseRuntime({
    authorize, lifecycle: store.lifecycle, network, protect,
    normalizeTool: normalizeSseTool, ledger, shutdownSignal,
}, pool)
const control = sseControlAdapter(sse)
```

Nothing connects at factory construction. There is no process-global SSE pool,
second connector registry, default fetch, environment credential inheritance or
new grant. Root injects and owns the pool/lifecycle instance.

Runtime methods:

```ts
sse.status(ref, signal)               // local authoritative reads only
sse.connect(request, signal)          // retain an owned live connection
sse.probe(request, signal)            // temporary discovery client, then drain
sse.tools(ref, trustedRun, signal)    // existing engine catalog discovery
sse.call(call, trustedRun, signal)    // durable claim before external dispatch
sse.disconnect(request, signal)       // exact current revision only
sse.releaseRun(localAgentId, trustedRun)
sse.dispose(localAgentId?, immutableServerId?) // trusted root lifecycle cleanup
sse.shutdown()                       // closes admission, drains live and retired
```

`createLegacySseConnection` is a lower-level owned connection factory used by
that runtime. It implements `open`, `call`, `drain`, failure state and exact
stream/request ID matching. Root should use the runtime, rather than bypass its
owner/pool/admission with another connection instance.

`adapters.ts` exports `sseToolDefinitions`, `sseOutcomeToolResult`,
`sseControlAdapter`. Definitions preserve original merged names and schemas;
their execution requires **both** UUID requestId and exact toolCallId from the
trusted root invocation. Uncertain output becomes an untrusted MCP `isError`
result carrying explicit no-auto-retry guidance, not placeholder success.

UI exports:

- `DesktopMcpTransportButtons` — original ordered transport control.
- `DesktopMcpSseEditor` / `DesktopMcpSseEditorProps`.
- `DesktopMcpSseConnection`, `DesktopMcpSseStatusBadge`, `SseStatusDriver`.
- `SseEditorDriver`, `SseEditorAttempt`, configuration/slot/identity helpers.

All UI callbacks must be created inside root's existing client settings boundary;
they are not serializable server-component props. No hosted action is imported.
The editor/list use the existing panel primitives with min-width/min-height,
scrolling body and wrapping controls/footer for narrow and short viewports.
No responsive/native execution was performed here.

## Required root changes, in order

1. **Contract export/build boundary.** Add the new source export to root-owned
   `packages/contracts/src/index.ts`:
   `export * from './desktop-mcp-sse.js'`. Engine normalization currently imports
   its type from that package. UI source imports the canonical source directly,
   as other isolated lanes do. Root builds/checks only after export integration.
2. **Remote configuration migration/model.** In root-owned MCP schema/store/model
   and numbered database/data-dir migration, add a stable immutable server ID and
   persisted transport discriminator. Backfill current remote rows as `http`;
   keep stdio's existing separate store unchanged. Do **not** infer a migration
   to SSE from `/sse` URL suffixes. Shared original MCP schema already knows `sse`.
   Enforce owner + server ID + immutable name + expected revision on updates and
   deletion, with a fresh revision on every configuration change. Preserve bearer
   ciphertext/AAD and existing OAuth bundles. No broad credential/variable delete.
3. **Durable invocation/settings receipts.** Root owns the schema/initialization
   and storage. The injected call ledger must atomically reserve by local owner,
   immutable server ID, session, run and toolCallId, with requestId/digest recorded.
   A changed requestId must not bypass an existing toolCallId claim. Digest binds
   exact ref/options/name/arguments. Existing/uncertain claims never dispatch
   again, including after restart. Settlement is compare-by-key-and-digest;
   storage errors never mean absent. Keep a late completed/unknown claim even if
   its observer was cancelled. Root storage retains its actual work/deletion lease
   until late SQLite work settles and drains it before closing the database.
4. **Authority/credential generation.** Extend the existing root `currentOwner` /
   `authorizeRun` / lifecycle authority rather than another permission service.
   `authorize(scope, signal)` must map the **local** ref to the exact saved row;
   reject disabled/deleting owners, missing `mcp` grant for use/call, stale revision,
   wrong immutable ID/name, and mismatched/stopped run for call. `read` is passive
   settings/status access; `close` permits authorized exact cleanup even when use
   has been disabled. Return `SseAuthority` with current canonical endpoint,
   opaque credential handle, private credential generation and `check()`.
   Every guard rechecks row/revision/credential generation. The generation must
   change for OAuth rotation, bearer replacement/removal and relevant auth changes;
   never put the raw token or engine identity in a public snapshot.
5. **Pinned credential/network boundary.** Bind `resolvePublic` to the existing
   strict `publicOAuthAddress`/equivalent public-address validator for **every**
   GET and POST. It must reject private/reserved/mixed DNS answers and return the
   validated numeric address/family, never merely unchecked DNS. The provided
   native HTTPS adapter pins lookup, keeps TLS hostname verification, disables
   pooling/ambient cookies/proxy inheritance, and never follows redirects.
   `credential(authority, signal)` freshly unseals the current lease's already
   supported Bearer/OAuth credential (or anonymous), with no arbitrary new headers.
   `protect(value, authority)` is a synchronous bounded scrubber using those exact
   credential values; existing HTTP's private inline redactor needs a root-owned
   reusable boundary. G separately redacts advertised protocol session values.
   Never log URL queries, bodies, header values, credential generation or server
   error text. Existing public validator's port/address restrictions still apply.
6. **OAuth preflight without admission deadlock.** Keep OAuth discovery/login/UI
   entirely in the existing helpers. Status/read must not call the refreshing
   `oauth.credential` path or perform network refresh. Authorize/guard and network
   credential access must be read/check/unseal operations. If root refreshes an
   existing OAuth token, do so through its existing explicit use/auth preflight
   **before** SSE admission. Then capture the new generation. Refreshing inside an
   admitted SSE guard while the credential-write hook waits for that same entry
   to drain would deadlock. Expired/uncertain auth can return auth-needed instead.
7. **Drain hooks before mutation/credential writes.** Add a root hook to the
   existing lifecycle/store, inside its already-reserved changing state, to await
   `sse.dispose(owner, serverId)` before edits/removal/credential rotation. Failed
   drain must block replacement and remain retryable. Owner disable/delete/grant
   revocation uses the existing owner transition reservation, invalidates root
   catalogs, then awaits `sse.dispose(owner)` before write. Run Stop/release calls
   `sse.releaseRun(owner, trustedRun)` and retains the existing bridge's stopped-run
   tombstones so a delayed old catalog cannot reopen after release. Do not just
   call the current synchronous `disconnect` and discard resource confirmation.
8. **Existing authenticated control/API dispatch.** Root's current
   `/api/desktop/coworkers/[agentId]/mcp` API remains the entry point. Resolve the
   authenticated local row and saved transport first; route only explicit saved
   `sse` to `control`. Validate canonical request IDs/revisions. HTTP stays on its
   existing runtime; stdio stays on its existing route. Neither G nor a renderer
   may select an engine owner, grant itself use, or dial arbitrary config bodies.
   No new unauthenticated control endpoint or arbitrary networking RPC is needed.
9. **Existing tool bridge/catalog.** In root's `mcp/tools.ts`, branch saved SSE rows
   to `sseToolDefinitions(sse, ref, trustedRun, signal)` and retain existing global
   collision/name/schema/catalog/server count checks across HTTP, SSE, stdio and
   app connectors. Root must pass the actual invocation's stable requestId and
   toolCallId to the SSE definition; current `bridge.ts` only passes arguments and
   AbortSignal, so its execution adapter needs that typed extension. Keep opaque
   catalog/capability ownership and run admission. Feed the resulting
   `{source:'remote_mcp',untrusted:true,result}` through the existing engine
   `desktop/mcp-tools.ts` / provider bridge, including real content/isError and
   uncertain guidance. Do not automatically create a new request/toolCallId to
   retry uncertainty, and do not start a follow-up turn from status/probe.
10. **Settings and restart integration.** Root inserts the exported row/editor in
    `DesktopCoworkerMcp.tsx` with local driver callbacks. Other transport buttons
    select existing HTTP/stdio editors; managed-app ownership is enforced again
    on the server, not just by readOnly. Save merges the narrow SSE delta into the
    existing row, preserving auth/other fields, under exact revision/request CAS.
    `SseEditorDriver.journal` must durably write-if-absent by owner/slot before save
    and clear only the matching request ID; it stores public config/delta only.
    Save/remove/reconcile return the exact same `requestId`; saved replies include
    the immutable server ref for saves. `unknown`/`refused` retain the attempt;
    only proven `not-saved` clears it without claiming success. A saved edit can
    hydrate an older pending revision for the same immutable server and reconcile
    it without resending. Pending creations keep their `new` draft slot; root must
    surface that exact pending request on restart rather than associate it to a
    different server by name. Deleted-server pending receipts reconcile by exact
    historical request identity. Root must not delete unrelated credentials.
11. **Shutdown/startup/packaging.** Retain one pool/runtime in the existing
    `mcp-binding.ts` service entry; no extra singleton. Shutdown aborts and awaits
    `sse.shutdown()` plus the existing bridge/storage drains, aggregating failed
    close rather than claiming success. Restart loads config/receipts only;
    `.status()` returns unchecked and opens no network stream. Never replay an old
    invocation, restore protocol session URLs, or hydrate a process-local live
    connection as connected. Root owns all packaging and native/full-restart QA.

Concrete private dependency types are in `types.ts`, not duplicated in another
contract. `SseAuthority.server` extends existing `RemoteServer`; the current model
lacks its ID/transport fields, so root migration and authority adaptation are hard
activation dependencies. `SseCallLedger`, settings journal, protected credential
access and current-run authority must be real implementations, not successful
stub callbacks. The original pure `toToolInputSchema` must reach the injected
normalizer at root's server build boundary; `normalizeSseTool` demonstrates direct
reuse without a second implementation. No G call can register a server or approve
H's self-MCP proposals. I's templates remain untouched; root/I must omit live IDs,
credentials, health/session state and receipt data from capture as appropriate.

## Protocol, bounds and privacy

Configured URLs still pass existing `mcp/model.ts endpoint`: HTTPS, no userinfo,
query or fragment. A distinct **protocol-only** endpoint validator resolves the
advertisement relative to that approved URL, insists on the same HTTPS origin,
and refuses userinfo/fragments/backslashes/controls/origin changes. It permits no
query or exactly one `sessionId` / `session_id`, 16–256 ASCII alphanumeric/underscore/
hyphen characters. Unknown auth/query fields, duplicates and short/noncanonical
sessions are explicitly unsupported. These values stay private and are redacted
if echoed; they never become public configured URLs or persisted live sessions.

The parser supports split UTF-8, BOM, CR/LF/CRLF boundaries, multiline data,
comments, endpoint/message events and bounded id/retry fields. It does not resume
from Last-Event-ID or implement automatic reconnect. Unknown events, invalid
UTF-8, incomplete data at EOF, malformed JSON-RPC, duplicate/foreign/late response
IDs, batches and unsupported methods fail closed on that stream. Server ping is
answered as a bounded protocol response; no server request can acquire sampling,
roots, elicitation, tools or another capability. Unrequested progress/logging is
unsupported; tool-list-changed invalidates the connection/catalog rather than
leaving stale tools callable.

Initialize/initialized and every pagination page must finish before a catalog is
published. Invalid names, duplicates, oversized/deep schemas, unsupported schema
conversion or malformed later pages refuse the **whole** server catalog.
Known JSON tool-result content/isError/structuredContent is retained as untrusted
bounded data; resource links are never fetched by this adapter. Raw server errors
are never quoted as failure messages.

| Bound | Value |
| --- | --- |
| Connect/discover / POST acknowledgement / tool request | 20000 / 20000 / 120000 ms |
| Close/drain / idle / absolute connection life | 3000 / 60000 / 600000 ms |
| Connections retained by root pool | 32 including retired/unconfirmed entries |
| Event / incomplete line budget | 1048576 / 1100000 bytes |
| Stream aggregate / event count | 16 MiB / 4096 |
| Request / result / catalog | 65536 bytes / 1 MiB / 1 MiB |
| Tools / pages / cursor | 256 / 8 / 4096 characters |
| JSON tree / depth | 10000 nodes / 32 levels |
| Inflight IDs / IDs per connection | 16 / 4096; independent bounded server-ping IDs |
| Names / descriptions / endpoint advertisement | merged name 128 / 8000 / 4096 characters |

Idle shutdown waits while client requests are pending; request/lifetime deadlines
still bound them. All late network opens are observed and closed. Root pool
entries retain admission tickets until confirmed local resource drain; a failed
close stays retired and blocks replacement, including probes. Different local
coworker/server identities have independent entries and streams.

## Failure and recovery table

| Event | Returned/retained outcome | Safe next step |
| --- | --- | --- |
| 401/403 or unavailable stored auth | needs_auth / auth-needed, no tool result | Existing explicit auth flow, then fresh connect |
| Unsupported endpoint/version/event/schema | unsupported or invalid-data; entire connection/catalog invalid | Correct config/provider and explicitly reconnect |
| Disabled/revoked/deleted owner, changed revision/credential/run | no stale publication; owned connection invalidated/drained | Refresh authoritative settings/current run |
| Timeout, disconnect or lost acknowledgement after call claim | uncertain with no result; durable claim kept | Inspect recorded outcome; never replay this attempt |
| Same call identity after restart/retry | uncertain; no GET or tools/call from that old claim | Root history may show a known result; future explicit work uses a new genuine invocation |
| Late GET open after abort | close observed resource; never connected publication | Retry disconnect if resource drain is unconfirmed |
| Failed close | closing / close-unconfirmed; retired entry/ticket kept | Retry exact disconnect/disposal; no replacement admission |
| Successful disconnect | local connection closed, pending calls remain potentially executed | Do not describe remote side effects as cancelled/stopped |
| Settings save/delete response lost | exact durable journal/request retained | Explicit reconcile, not a new UUID or repeat mutation |
| Known not-saved settings verdict | matching journal cleared, form unlocked, no onDone success | Refresh/correct and make a genuinely new user attempt |
| Restart/passive status/editor hydration | saved config, unchecked status; no connect/probe/tool | User explicitly chooses Connect/Probe; old calls never resume |

Closing an SSE transport does not prove a remote tool's side effects were undone
or its background job stopped. Legacy MCP provides no general remote cancellation
receipt here. The local close acknowledgement and the uncertain tool outcome are
kept separate. No cancellation POST is sent after authority is revoked.

## Implemented / dependent / unsupported matrix

| Slice | Owned source implemented | Root dependency | Unsupported / excluded |
| --- | --- | --- | --- |
| Canonical contract | Strict identities, requests, snapshots/outcomes and named bounds | Barrel export and DTO integration | Private credentials/engine IDs/session URLs in public snapshots |
| Legacy protocol | Real GET/endpoint/POST handshake/list/call and ID dispatch | Injected current store/authority/network | Explicit SSE fallback to HTTP or stdio; automatic reconnect |
| Credential confinement | Same-origin advertisement and dedicated query policy; pinned HTTPS factory | Public resolver, credential generation/read/redaction | Arbitrary headers, cookies, redirects, new OAuth/login/storage |
| Discovery/schema | Bounded atomic catalog and original normalization injection | Build reuse of original normalizer, central catalog checks | Partial malformed catalogs, unrequested server capabilities |
| Exact execution | Trusted-run checks, durable claim before dispatch, uncertain outcomes | Actual durable ledger and bridge invocation IDs | Replaying old/uncertain tools/call after reconnect/restart |
| Ownership/Stop | Root-owned pool, shared tickets, exact owner/server/run release, retained failed drains | Mutation/revocation/shutdown hooks and storage draining | Claiming remote side effects stopped just because the stream closed |
| Settings/UI | Original controls/layout/status, managed read-only, durable-attempt callback flow | Existing save/auth/UI mount, real journal/CAS receipts | Hosted actions, new secret editor, auto-connect/probe/save on mount |
| Restart | Unchecked saved config, exact pending settings reconciliation, no call replay | Migrations and authoritative history/recovery | Persisting live protocol session tokens or reviving old streams |
| Regression sources | Contract, parser/endpoint, network boundary, runtime, normalization and UI cases | Root executes all checks, repairs and native/restart QA | Any tested/accepted/E5-complete claim by G |

## Authored, unrun regression sources

- Contract `desktop-mcp-sse.test.ts`: strict owner/ref/request fields, no private
  fields, result only for completed outcomes (Node built-in test source).
- `parser.test.ts`: one-byte UTF-8/CRLF/multiline fixtures, comments, truncation,
  oversized/invalid events, same-origin/session query/credential attacks.
- `network.test.ts`: fake root public-address rejection, invalid pin and rotated
  credential admission. Every fixture rejects **before** native HTTPS; no actual
  DNS/server/address is contacted.
- `runtime.test.ts`: fake real legacy GET/endpoint/POST initialize/list/call flow,
  redacted echoes, passive restart/status, durable no replay, all-or-nothing
  discovery, wrong owner/revision/run, credential rotation, Stop/revoke/delete,
  reverse-order concurrent IDs, duplicate/foreign IDs, isolated coworker close,
  redirect rejection, POST admission generation change, failed-close retry and
  late-open cleanup. No fixture opens sockets.
- Engine `normalize.test.ts`: original required-choice schema normalization/notes.
- UI `presentation.test.tsx`: original labels/order, read-only managed controls,
  existing HTTP routing callback, no secret field, unknown save/revision/reopen
  reconciliation with the same identity, passive mount/stale owner reads and
  retryable failed disconnect.

These are source cases, not executed evidence. Real pinned-DNS/TLS/network,
OAuth/Bearer lifecycle, durable database/mutation journaling, simultaneous
provider/Stop races, original HTTP/stdio regressions, board/worker tool delivery,
Mac display and full restart acceptance remain root work. G did not change any
shared checklist item or mark E5 accepted.
