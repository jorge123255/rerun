# Round33 G — SSE and local-program app connections

Source handoff only. E4 is not marked accepted. Root execution and installed Mac/full-restart acceptance are pending.

Assigned worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round33-service-transports`.
Branch: `desktop/round33-service-transports`.
Prepared parent: `f14ad18888407c68827d9c2a9b2ae6e545f0d3d9` (verified before editing).
Original Rerun design pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.
Common accepted-source candidate supplied by root: `56fdce61a780e005644057cc77d8edebbf0d067a`; this lane makes no installed-acceptance claim about it.

The attached Round33 assignment superseded the prior active task. Root's Round32 SSE snapshot is present in this branch and was read, not edited. The old Round32 author worktree was left untouched. No round31 files or another lane's files were modified. No Round33 interface agreement was present in `docs` when inspected. Applicable instructions and the installed Next.js `use-client.md` in root's build worktree were read. No dependencies were installed.

## Result and exact boundaries

The owned package supplies a declarative compiler, secret-reference execution resolver, account/run authority checks, durable receipt orchestration, actual dispatch to the canonical Round32 SSE core, an adapter to the canonical local-program lifecycle, original method/field presentation, account status/retry/Stop UI, and source regressions. It creates no registry, pool, route, SQL table, credential store, process runner, OAuth flow, package installer or permission system.

Root must provide the existing account authority, durable journals/receipts, exact-account stdio methods and spawn environment binding. They are required typed dependencies, not successful placeholder implementations. Until those are bound, neither this package nor the catalog should advertise a usable connection. In particular the existing stdio runtime lacks exact-account discovery/status, environment injection and exact-server run release. Calling its owner-wide `tools()` or `releaseRun()` from the new account adapter would affect sibling accounts and is prohibited.

## Original source and design mapping

Read with `git show` at the original pin:

| Original source | Reuse and necessary Mac adaptation |
| --- | --- |
| `apps/ui/lib/services/manifest.ts` | Existing normalized `ServiceManifest`, `AuthMethod`, input definitions, method order, labels, defaults and env-key mappings. Unknown selected methods refuse instead of falling back. |
| `apps/ui/lib/services/compiler.ts` | Compile catalog templates, preserve input references until execution, account-specific server names and usage-skill footprint. Mac resolves secrets through root callbacks rather than hosted engine env writes. No hub headers or automatic package preparation. |
| `apps/ui/lib/services/registry.ts` | Bare slug identifies the base account; `slug@instanceId` identifies an additional account. Labels are display only. Root/F remain the only registry and skill ownership authority. |
| `apps/ui/components/services/AuthMethodPicker.tsx` | Reused directly as a presentation component. Original ordered drill-in cards, icons, author labels and fallback `API key`, `Local`, `Sign in`, `Connect`. |
| `apps/ui/components/services/ServiceConfigForm.tsx` | Authentication heading, method drill-in/back, original field ordering, Install/Installing…, Connect and inline errors. New local callbacks replace hosted setup/OAuth children. Mount only reads the local journal. |
| `apps/ui/components/services/ServiceInstalledBlock.tsx` | Compact check badge, `{name} installed`, and `Available on the next turn: …` receipt, without hosted cache effects. Receipt must be mounted only for an acknowledged root install. It is not transport health. |
| `apps/engine/src/tools/mcp.ts` | Explicit `sse` vs `stdio` dispatch, legacy GET SSE path through Round32 core, `<server>_<tool>` names, schema normalization through injected original helper. No second transport implementation. |
| `apps/engine/src/tools/mcp-pool.ts` | Root owns lifecycle/pool, owner/server identity, current configuration and credentials, Stop and late-open drain. No separate connection cache in this package. |

Also read current Mac compiler/catalog classification, MCP model/bridge, stdio store/runtime/process, Round32 SSE runtime/network/validation and the full Round32 F source handoff at `round32-service-accounts/docs/desktop-round32-f-handoff.md`, plus its canonical contract. F's actual contract is **not yet present in this prepared branch**. The new contract type-imports `DesktopServiceAccountView` from `desktop-service-accounts.ts`; root must integrate F's source. No replacement account contract was authored here.

Responsive source uses the original single-column forms and `PanelSteps`, `min-w-0`, wrapped control rows, word wrapping, and a scrollable `max-h-[70dvh]` setup. Native/window-width acceptance was not performed.

## Canonical public contract and exports

`packages/contracts/src/desktop-service-transports.ts` is the sole new transport/account adapter contract:

- `ServiceTransportAccount` is a `Pick` of F's canonical installation identity, not a second account model.
- `ServiceTransportRef` is `{ agentId, key, installationId, revision }`. `revision` is F's expected configuration revision. `installationId` prevents delete/recreate adoption. `key` accepts the original bare slug or instance key. The upstream `isServiceRegistryKey` helper recognizes **instance keys only**; this projection also accepts a bounded bare slug.
- `ServiceTransportControl` adds UUID `requestId` and `status | probe | reconnect | disconnect | stop`. No engine identity, command, headers, URL, secrets, grants or method override comes from this body.
- `ServiceTransportSnapshot` exposes method id, transport, bounded tool metadata, saved/live/probe observation, state and optional safe receipt.
- `ServiceTransportReceipt` contains only the exact ref/request/action, outcome/state and failure enum. No raw exception, result payload, arguments or credentials is persisted by this orchestration.
- `ServiceTransportSetupIntent` contains ref/requestId/methodId only. It deliberately excludes form values.
- `ServiceTransportMethod` extends original method summary metadata with capability/dependency reasons.
- `SERVICE_TRANSPORT_LIMITS` and `SERVICE_TRANSPORT_COPY` are the canonical bounds and safe public failure text.

Server exports (direct module imports; no barrels edited):

```ts
compileServiceTransport(manifest, methodId, ref): TransportPlan
serviceTransportMethods(manifest, ref): ServiceTransportMethod[]
parseTemplate(text, inputs, allowBasic?): Template
assertRemoteEndpoint(value): string
resolveTransportMaterial(authority, valuePort, programPort, guard, signal)
createServiceTransports(dependencies)
canonicalSseServiceDriver(existingSseRuntime, accountBinding)
canonicalProgramServiceDriver(existingExactAccountStdioAdapter)
serviceTransportApi(runtime) // { control, reconcile }
serviceTransportDefinitions(runtime, ref, discoveryRequestId, trustedRun, signal)
```

`createServiceTransports` returns `status`, `control`, passive `reconcile`, `discoverForRun`, `serverName`, `call`, `stopRun` and `beforeChange`. `TransportDependencies`, `TransportAuthority`, `ValuePort`, `ProgramPort`, `DriverContext`, `TransportDriver`, `CanonicalProgramLifecycle` and `SseAccountBinding` are the root seams. Server modules import no engine internals or hosted actions. No engine file was needed; engine consumers must use `@rerun/contracts` after root adds the export.

Client/presentation exports:

```ts
createServiceTransportClient({ post, reconcile, journal, uuid })
ServiceTransportMethodPicker({ methods, onSelect })
ServiceTransportSetup({ account, name, methods, initialMethodId,
  configuredInputs, ports, onSaved, onCancel })
ServiceTransportConnection({ account, name, client })
ServiceTransportInstalledReceipt({ name, toolNames })
```

`ServiceTransportSetupPorts.save(intent, values, signal)` delegates to the existing account install/reconfigure and secret authority; it is not a new credential endpoint. `reconcile(intent, signal)` must read that same attempt without re-submitting values or starting OAuth. Acknowledgements carry the exact `requestId`; `saved` also returns the current exact installation ref. `onSaved` is called only after that acknowledgement and journal CAS clear.

## Exact root integration order and required interfaces

### 1. Contracts and shared migrations

Integrate F's canonical `packages/contracts/src/desktop-service-accounts.ts` and account lifecycle first. Then add to root-owned `packages/contracts/src/index.ts`:

```ts
export * from './desktop-service-transports.js'
```

Do not add a production test export. New regression files here live under UI owned test directories, outside `packages/contracts/src`; the production contracts tsconfig currently includes all `src`.

Use the existing database and F account installation ID. Root persists:

- installation -> transport/server ID, canonical server name, server revision and private config/credential generations;
- mutation/setup receipts through F's existing account reservation mechanism;
- service transport request claims and safe receipts, in a distinct namespace from the SSE core's protocol claims;
- client public pending control/setup journals keyed by `(agentId, installationId)` with CAS by requestId.

Receipt primary identity is `(agentId, installationId, requestId)`. Conflicting fingerprints refuse. Calls additionally require a unique `(agentId, installationId, engineOwnerId, sessionId, runId, toolCallId)` so generating a new UUID cannot replay the same invocation. Claims commit durably **before** discovery/start/call effects. Same-ID claims never restart probe/reconnect/call; completed control receipts replay as historical observations with `unchecked`, not fresh health. Close-only retries may resume an unconfirmed drain. Keep claim tombstones across shutdown and remove/reinstall. Do not TTL them inside the provider/run retry horizon. Missing/unreadable receipt means uncertain, never new.

`TransportDependencies.receipts` is deliberately required, with no in-memory production fallback. Fingerprints contain SHA-256 of the bounded canonical arguments and identity, not raw arguments. Root can wrap this digest in its keyed account reservation fingerprint. Store only the public `ServiceTransportReceipt`; root's claim key may contain private run identity.

### 2. Compiler dispatch and declarative save (root-owned `services/compiler.ts`, `accounts/compiler.ts`, `accounts/lifecycle.ts`, account store/schema)

Keep current HTTP handling. Select this compiler only for original SSE/local-program methods. Never classify HTTP as unsupported globally because this helper only handles this lane's two transports.

```ts
const plan = compileServiceTransport(manifest, exactMethodId, {
  agentId: localCoworkerId,
  key: account.key,
  installationId: account.installationId,
  revision: account.revision,
})
```

The manifest is loaded from the trusted bundled catalog, never accepted from a route. The selected method ID is exact. Root must allocate/claim account identity using F **before** invoking this compiler for a new/additional account. The setup UI's ref therefore addresses a root-reserved installation. A pre-save reservation is not an installed account or permission grant. Unallocated new-account UI remains F's responsibility; do not fabricate an installation UUID in the browser.

Save the declarative plan under that installation, including transport, method ID and canonical original account server name. Do not save `ResolvedTransport`. Preserve F's blank-secret reuse only for the same current installation/generation; masks and wrong types remain errors. Public inputs and secret references stay separate. No credentials in previews, template export, tool names or history. Root's template serializer must export only approved declarative catalog/config input metadata and exclude secret references/material. Saving configuration does not probe, sign in, start a process, install a package or grant Apps/MCP/local-program use.

Root's account mutation reservation must call `beforeChange(priorAuthority, signal)` **before** method changes, credential rotation, disconnect-with-credential-removal, disable, remove and owner transition. Do not publish new revision or erase the old binding until the exact prior transport is drained. On failure preserve the reservation/binding so a later Stop can retry. After drain F owns exact-account secret deletion, server footprint changes and skill reference counting. This adapter never removes skills or sibling credentials.

### 3. Current authority and secret references (`mcp-binding.ts`, account lifecycle/grants)

Required authority shape is exported in `types.ts`. Root implements:

```ts
const deps: TransportDependencies = {
  authority: async (ref, action, run, signal) => {
    // Authenticate current local coworker; look up exact key + installation + revision.
    // Verify saved method/transport/binding and current engine/run/session identity.
    // Return current private generations, plan, enabled and independent grant bits.
    // check() must synchronously invalidate on mutation/revoke/shutdown.
    return authority
  },
  values: existingAccountSecretReferencePort,
  programs: reviewedInstalledProgramPort,
  drivers: { sse: sseDriver, stdio: programDriver },
  receipts: durableServiceTransportReceiptPort,
  operations: existingAccountOperationLifecycle,
  normalizeTool: normalizeDesktopSseTool,
  protect: redactCurrentAccountMaterial,
  assertToolNames: checkReservedAndSiblingNames,
  shutdownSignal,
}
const transports = createServiceTransports(deps)
```

The code rechecks enabled + Apps grant + **remote** grant for SSE, or enabled + Apps grant + **local-program** grant for stdio. Discovery and invocation both require the appropriate grant. `read` must be passive; `close` must permit draining a disabled/revoked installation. Root's authority also verifies trusted active run/session, not just the engine string. Binding/generation changes reject before effects and before publication.

`ValuePort.read` returns either `{kind:'public',value}` or `{kind:'secret',reference}` for that exact installation/input key. `unseal` reads only its encrypted canonical account credential bundle. The code rejects classification changes, unknown keys, missing required values, CR/LF/control bytes, oversized values, unresolved `${…}` and bad select options. Secrets never enter a template plan. `oauthBearer` is F's already-established current token lookup; it must not open a browser or refresh while an admitted transport operation is held. Root/F do explicit preflight OAuth outside this admission before issuing a new explicit operation. Passive status never refreshes OAuth.

`operations.admit` is the existing account lifecycle admission, not a new MCP pool. It must be exclusive against root config/remove reservations and retain tickets until late asynchronous work and resources settle. `cancel(ref, run?, signal)` must abort and await only that installation and optional run, retain failed drains, and not cancel a newly admitted unrelated generation. Disconnect/reconnect cancel older operations before opening new ones. A broken dependency that ignores abort cannot be called stopped: drain must fail and keep recoverable ownership.

`protect` is required for metadata and results. Redact all account credential values and encoded forms, access/session/protocol tokens, including very short secrets (refuse unsafe output if redaction is not reliable). Never log `DriverContext`, resolved material, raw transport exceptions, requests or results. Tool metadata is validated atomically after redaction and original normalization; malformed/duplicate/colliding tools do not partially publish. Results must pass the existing bounded MCP result validator. No resource link is fetched.

### 4. Canonical SSE (`mcp-sse/runtime.ts`, current remote config/lifecycle/network, root-owned)

```ts
const sseDriver = canonicalSseServiceDriver(existingSseRuntime, {
  reference: async (accountAuthority, material) => canonicalSseReference,
  releaseServerRun: (serverRef, run, signal) => exactServerRunRelease(serverRef, run, signal),
})
```

`reference` reads the durable existing account -> server footprint and verifies agent, immutable server ID, server name, server revision, account config/credential generation and exact resolved material equality. It must not register/configure a server or mirror credentials during discovery. With no `material` it is a pure read suitable for status/drain. With material it checks that only this account's URL/bearer can be consumed by that server. Credentials remain private in the root credential boundary. Never send an account bearer to a binding merely matched by display name.

The canonical SSE runtime must receive the same account enabled/grant/revision/generation/run guard on every GET, advertised POST and publication. Continue using its required pinned public-address network boundary, same approved HTTPS origin and protocol-session-query rules, no redirects, no host headers or hub auto-auth. Do not relax configured URL policy. Original `/sse` inference is only for an original catalog template lacking `transport`; persisted remote configuration migration must keep old HTTP rows HTTP as documented in the Round32 handoff.

Actual initialize/list/call/probe/Stop code is the copied Round32 core, not this adapter. `runtime.dispose(agentId, serverId)` is used for exact-account drain. Existing `runtime.releaseRun(agentId, run)` is too broad: root adds exact-server run release that filters owner + immutable server ID + run, including retired/probe entries, before retiring. Do not implement this by closing all the coworker's streams.

### 5. Canonical stdio and reviewed package prerequisite (`mcp-stdio/runtime.ts`, `store.ts`, `process.ts`, E/root package binding)

```ts
const programDriver = canonicalProgramServiceDriver(exactAccountProgramLifecycle)
```

`CanonicalProgramLifecycle` is the required exact-account projection of the accepted runtime. It has passive `status`, `discover(context, requestId, mode, run?)`, `call(context, invocation)`, `drain(authority, signal)` and `releaseRun(authority, run, signal)`. Root must implement the following changes inside the existing pool/runtime; this lane intentionally does not duplicate process code:

- Add a targeted `toolsFor(owner, name, revision, run, signal)` using the existing `connect`/`operation` machinery, instead of calling `tools(owner, run)` (which starts every connection).
- Bind the target to installation ID + config generation + credential generation + executable identity and trusted workspace. Match exact selected tool/schema before dispatch.
- `probe` uses the selected existing connection and closes its temporary process after discovery. It must not leave an untracked child; successful probe remains a historical observation.
- Support an injected **per-entry** environment material provider if catalog credentials are required. Merge only the existing minimal `stdioEnvironment` and validated account-specific env; never `process.env` or another account/coworker's env. Recheck generations immediately before spawn and write. Retain original process-group TERM/KILL/confirmed-drain logic and late-open closure.
- Expose passive in-memory state for exactly this account; after process restart it is unchecked. No `store.read`/status should start a process.
- Expose exact-server run release. Existing owner-wide `releaseRun` closes siblings and cannot be used here.
- Propagate Stop into the existing pending RPC and process group, retain failed drains, preserve durable existing `store.claim` invocation tombstones, and redact results before publication.

`ProgramPort.resolve(ref, catalogCommand, originalArgumentTemplates, signal)` is a **read-only** E/root approved installed-package mapping. It returns `{ executable, args, supportsEnvironment }` or `null` for a missing/unapproved program. It may strip reviewed package-runner/install arguments to target an already installed executable, but it must preserve the reviewed server's semantics and reject unknown package/version/method changes. Do not execute or download `npx`, `uvx`, npm, pip, shells or package managers. `validateExecutable` should wrap existing `executableIdentity`; `validateArguments` is root/E's reviewed executable-specific argv/path policy. No shell interpretation. Missing executables and unsupported prerequisite capabilities stay unavailable.

This resolver rejects relative/traversing/control/whitespace executable paths, banned shell/package executables, interpreter/eval/import flags, unsafe environment variable names and process-loader keys. It refuses any secret placed in argv (including the original Neon and Plaid catalog templates); process arguments are externally inspectable. No secret-as-argv workaround is supplied. Account env credentials are supported only when the canonical lifecycle advertises and implements `supportsEnvironment`; the current spawn path does not, so all env-based catalog programs remain dependent until root wires that seam.

### 6. Existing authenticated routes, bridge/providers and tool catalog

`serviceTransportApi(transports)` provides binders, not Next route exports. Root dispatches through the existing authenticated account/API binding. Parse a bounded JSON body, authenticate the path coworker, then call `api.control(body, localAgentId, request.signal)` or passive `api.reconcile(...)`. The browser client accepts injected callbacks, so this lane invents no parallel URL/route registry. Do not expose `call`, `beforeChange` or a client-selected run as a settings endpoint.

Engine/provider bridge:

```ts
const definitions = await serviceTransportDefinitions(
  transports, exactInstallationRef, stableDiscoveryRequestId, trustedCurrentRun, stopSignal,
)
// Existing provider/Codex bridge receives definitions after central name/grant checks.
await definition.execute(args, { requestId: stableInvocationUuid, toolCallId }, stopSignal)
```

Names come from the current server plan, not a client parameter. Root validates central reserved names and cross-account collisions in `assertToolNames`; enforce aggregate catalog count/bytes across all service/HTTP/stdio/SSE definitions as well. Preserve the existing wrapper `{ source:'remote_mcp' | 'local_mcp_stdio', untrusted:true, result }`. Uncertain calls return an MCP `isError` result with safe guidance and their receipt, never synthetic successful tool content. Do not generate a new invocation UUID or toolCallId automatically after a timeout, Stop, missing ACK or restart. A future user-requested operation has a distinct identity; it is not replay of the previous call.

The outer service receipt namespace and inner existing SSE/stdio call claim namespaces must not collide: otherwise the inner canonical transport would correctly see the outer claim as a duplicate. Both must preserve no-replay uniqueness. Root owns provider/run/queue tombstones, normal run completion vs Stop semantics and identity admission. `stopRun(ref, run)` targets the selected installation; root may separately iterate the explicitly owned installations when stopping an entire run.

### 7. UI mount, save/auth and shutdown

Root's existing Apps panel/F account picker selects one installation and supplies the contract ref. Reuse its setup save/secret/OAuth actions. Stable memoized clients/ports should be passed from a client parent (Next client callbacks do not cross a server component serialization boundary).

```tsx
<ServiceTransportSetup account={ref} name={detail.name}
  methods={transportMethods} initialMethodId={account.authMethodId}
  configuredInputs={account.configuredInputs}
  ports={existingDurableAccountSetupAdapter}
  onSaved={refreshAccountWithoutProbe} onCancel={closeSelectedSetup} />
<ServiceTransportConnection account={ref} name={account.label ?? account.name}
  client={memoizedTransportClient} />
```

`memoizedTransportClient` is `createServiceTransportClient({ post: authenticatedExistingAccountControl, reconcile: authenticatedExistingAccountReceiptRead, journal: publicControlJournal, uuid: crypto.randomUUID })`, memoized for the active Apps host. All callbacks use the existing authenticated account route binding.

Setup journal values contain only ref/requestId/methodId; form secrets remain ephemeral and are cleared after submission/Cancel. Journal `put` must reject replacement by a different pending request, and `clear` is compare-and-delete by requestId. Same installation can reconcile a saved attempt at its earlier revision after reopen; it never auto-sends old values. Root's reconcile callback must verify the same installation and request before returning the new current revision. New installation IDs and owner changes cannot adopt that journal.

Control journal hydration/status are passive. Unknown probe/reconnect retains the attempt. Reconcile reads the receipt without replay. Explicit **Retry connection** archives that public pending intent and starts a newly identified reconnect that first cancels/drains older selected-account work. The old server receipt/tombstone remains. **Stop** aborts the current UI read/operation immediately, persists its own attempt and requests canonical drain even while a check is pending. A failed Stop retains its same ID for Retry Stop. Cancel setup does not skip, delete credentials or send a chat reply.

Root handles existing setup/OAuth dialog mounting, per-account public configured flags, account receipt refresh, removal UI, owned skill preservation and any chat follow-up exactly once after durable install acknowledgement. The installed receipt must never be used as a health result.

On app shutdown root first aborts `shutdownSignal`, prevents new account admissions, cancels/awaits exact operations, then drains existing SSE and stdio lifecycles. Failed closure remains recoverable. On startup load only durable config/journals/tombstones and reset health to unchecked; never connect, probe, refresh tokens, start processes or rerun a tool because history was opened. All startup/migrations/packaging files remain unchanged here.

## Bounds and placeholder policy

- 1 MCP server per method; 64 inputs, 8 KiB/input, 32 KiB/template/resolved field.
- 64 args, 4096 chars/arg; 64 explicit env keys; forbidden loader/system environment keys.
- 256 tools, 1 MiB catalog/result, 64 KiB tool arguments; reuse existing SSE JSON depth/node/schema/result validation.
- 120 s operation deadline and 5 s outer close/receipt-settlement wait; canonical transports retain their tighter connect/frame/idle/process bounds.
- `${input.KEY}` is the supported substitution. Unknown/nested `${…}`, agent/hub/global env references and skill-body placeholders refuse. Basic placeholder syntax can be parsed explicitly but no supported SSE Basic/custom-header transport is advertised; only exact Bearer or anonymous, or F's existing OAuth bearer, reaches the canonical remote core.
- Only non-secret input substitutions may affect canonical HTTPS URLs/argv. URLs must have no userinfo, query or fragment and may not target hosted Rerun proxy authority. Root's approved/pinned public-address policy still applies at every actual connection.
- Missing optional inputs resolve to an empty string; required configured values must exist. No display mask or inline secret is written by this resolver; root/F retains its existing input validation at save.

## Supported catalog method matrix (source inspection, not execution)

The bundled seed contains 3 SSE methods and 32 stdio methods. All stdio templates name `npx` or `uvx`; none authorizes installing or executing a package runner. Table below is generated from that checked-in source, preserving authored labels. Blank original labels use the original method-kind fallback in the UI.

| Catalog slug | Exact method ID | Original label | Transport | Source readiness / prerequisite |
| --- | --- | --- | --- | --- |
| apollo | api-key | Apollo API key | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| asana | pat | Personal access token | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| assemblyai | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| cal-com | api-key | API key | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| crowdstrike | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| dataforseo | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| deepgram | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| discord | default | (original kind fallback) | stdio | Unsupported secret argv; no workaround |
| email-imap-smtp | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| expedia | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| figma | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| getxapi | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| gong | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| hubspot | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| kie-ai | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| kit | api-key | Kit API key (v4) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| klaviyo | api-key | Klaviyo private API key | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| meta-ads | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| monday | api-token | API token | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| n8n | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| neon | api-key | API key | stdio | Unsupported secret argv; no workaround |
| notion | integration-token | Internal integration token | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| okx | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| omni | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| pagespeed-insights | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| perplexity | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| plaid | default | (original kind fallback) | stdio | Unsupported secret argv; no workaround |
| producthunt | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| replicate | default | (original kind fallback) | sse | Dependent: F current OAuth token + root SSE binding |
| shopify | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| slack | default | (original kind fallback) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| square | oauth | Sign in with Square | sse | Dependent: F current OAuth token + root SSE binding |
| square | access-token | Access token (local server) | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| webflow | api-token | Webflow API token | stdio | Dependent: approved installed program + exact-account stdio + env injection |
| wrike | permanent-access-token | Permanent Access Token | sse | Supported Bearer shape; root account/SSE authority and grants required |

Other HTTP methods retain existing root/F support. Hosted managed/Composio/paid methods and custom-header SSE are unsupported by this transport adapter. Anonymous SSE and already-approved direct absolute executable templates are supported shapes even though the current seed uses the shapes listed above. This matrix is not a provider compatibility or installed-program claim.

## Failure and durable recovery

| Event | Result / retained identity | Recovery |
| --- | --- | --- |
| Missing program, env capability or sign-in | Unavailable/auth-needed; no process/tool call | Explicit root setup or approved installed binding, then a new explicit check |
| Wrong owner/install/revision/run or missing grant | Refusal before effect; no implicit permission | Refresh current exact account or enable the correct grant explicitly |
| Method/config/credential changes during work | Current generation guard rejects publication; claimed call remains uncertain | Root drains prior binding before committing new config; do not replay |
| Lost call/POST/process acknowledgement, Stop or deadline | Uncertain; durable call and invocation uniqueness remain | Inspect remote/app effects; a user may request a distinct future operation |
| Lost control acknowledgement | Same public pending request remains | Passive Reconcile; duplicate connect/probe does not start another connection |
| Failed process/stream close | Closing / close-unconfirmed | Retry the same Stop ID; no replacement while root retains retiring resource |
| Completed historical discovery after restart | Unchecked, no callable tools from the receipt | Explicit new check/reconnect or trusted new run discovery |
| Delete/recreate base slug | Old installation ID is not adopted | Root reserves a new installation and preserves the old tombstones |
| Cancel setup/lost save ACK | Same setup intent, no secret values in journal | Reconcile same root account mutation; no automatic save/sign-in/follow-up |
| Sibling account changes/removal | Targeted drain leaves other account refs/generations/skills alone | Root skill ownership and secret-footprint logic remains authoritative |

## Implemented / dependent / unsupported

| Capability | Classification | Remaining boundary |
| --- | --- | --- |
| Canonical contract, pure compile and bounded secret-reference resolution | Implemented source | Root integrates F contract and barrel |
| Actual legacy SSE initialize/list/call and cancellation dispatch | Implemented adapter over Round32 core | Root binds exact account/current credential + pinned network authority; core unchanged |
| Exact-account stdio lifecycle projection | Implemented adapter interface/dispatch | Root adds targeted discovery/status/env/run-release to existing runtime; no duplicated process implementation |
| Durable no-replay orchestration and passive reconciliation | Implemented source | Root durable atomic receipt/claim/journal storage and dual invocation uniqueness |
| Original picker, fields, setup, status, Stop, retry and receipt | Implemented source | Root Apps/account mount and save/F OAuth callbacks |
| Approved program selection | Dependent | E/root reviewed installed package binding; no install by this package |
| Catalog env-based local programs | Dependent | Exact canonical per-account env injection and credential generation checks |
| Catalog SSE OAuth methods | Dependent | F's existing local OAuth/token authority; no OAuth flow added |
| Catalog Neon/Plaid secret argv | Unsupported | Secrets must not appear in process arguments |
| SSE custom headers/Basic, arbitrary global/env/hub placeholders | Unsupported | Canonical SSE network currently supports anonymous/Bearer only |
| Hosted managed/Composio/paid app proxies | Unsupported | No hosted credentials/authority fallback |
| Test/type/lint/build/native/installed acceptance | Pending root | Nothing executed by this lane |

## Authored regression sources — all unrun

- `compiler.test.ts`: exact methods, account names, placeholder/URL/header attacks, references, secret containment, missing programs, forbidden argv/env/executable bindings.
- `contract.test.ts`: rejects engine/header/executable/inline credential fields and private generation snapshots.
- `lifecycle.test.ts`: passive restart, separate grants, wrong owner/revision/run, calls and lost ACK across restart, Stop, credential changes, failed close retries, passive reconciliation, targeted run/removal and conflicting IDs.
- `drivers.test.ts`: actual canonical SSE API dispatch, uncertainty, exact server drain/run release, guarded program delegation.
- `client.test.ts`: same-ID lost-ACK journal/restart, foreign acknowledgement refusal and public-only journal shape.
- `presentation.test.tsx`: original labels/order, password fields, no save on mount, same-ID setup reconciliation across revision, stale owner reads and Stop during a pending check.
- `regression-harness.ts`: fake lifecycle, in-memory **test-only** receipts, fake drivers, no sockets/process/Keychain/filesystem.

The unchanged Round32 parser/network/runtime regression sources remain the fixtures for real legacy GET endpoint/POST framing, redirect/address/session attacks, late opens and SSE wire interruption. They were not run or altered. Root must exercise these alongside the new adapter sources and verify package executable/env/Stop behavior after integration.

## Changed files
- `apps/ui/components/desktop/services/transports/ServiceTransportConnection.tsx`
- `apps/ui/components/desktop/services/transports/ServiceTransportMethodPicker.tsx`
- `apps/ui/components/desktop/services/transports/ServiceTransportSetup.tsx`
- `apps/ui/components/desktop/services/transports/presentation.test.tsx`
- `apps/ui/lib/desktop/server/services/transports/api.ts`
- `apps/ui/lib/desktop/server/services/transports/bridge.ts`
- `apps/ui/lib/desktop/server/services/transports/client.test.ts`
- `apps/ui/lib/desktop/server/services/transports/compiler.test.ts`
- `apps/ui/lib/desktop/server/services/transports/compiler.ts`
- `apps/ui/lib/desktop/server/services/transports/contract.test.ts`
- `apps/ui/lib/desktop/server/services/transports/drivers.test.ts`
- `apps/ui/lib/desktop/server/services/transports/drivers.ts`
- `apps/ui/lib/desktop/server/services/transports/lifecycle.test.ts`
- `apps/ui/lib/desktop/server/services/transports/lifecycle.ts`
- `apps/ui/lib/desktop/server/services/transports/regression-harness.ts`
- `apps/ui/lib/desktop/server/services/transports/resolve.ts`
- `apps/ui/lib/desktop/server/services/transports/types.ts`
- `apps/ui/lib/desktop/service-transports-client.ts`
- `docs/desktop-round33-g-handoff.md`
- `packages/contracts/src/desktop-service-transports.ts`

All changes are owned new files. No tests, type checks, lint, builds, dependency installation, servers, packaging, live requests/providers/APIs, Docker, native UI, Keychain or full-restart QA were run. No push, merge, publication or installation. Root fixes integration/check failures and determines installed acceptance.
