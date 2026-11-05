# Round 32 · Lane E7 (Agent H) — Desktop self-MCP (proposal → review → trusted config)

Ports Rerun's hosted `mcp_register` self-improvement tool into the Mac desktop app as a
**proposal → human review → trusted local configuration** lifecycle. Registration and tool
execution stay **distinct decisions**: the model may propose an MCP server and nothing more —
it can never approve its own proposal, grant itself execution permission, install a package,
launch a local program, or silently replace a trusted connection. Only an explicit local human
decision may probe and save, behind the existing MCP configuration/transport adapters and the
separate local-program grant.

Branch `desktop/round32-self-mcp`, base `ab0de35eb45fbcf0b801943fd8ad7c3c861b9210`. Regressions
are **authored and unrun**; root runs all checks. No acceptance claimed.

---

## 1. The one canonical contract

`packages/contracts/src/desktop-self-mcp.ts` (root adds the barrel export — see §6.1). Schemas
(all `.strict()`, zod `^4.4.3`):

| Schema / helper | Shape | Notes |
| --- | --- | --- |
| `selfMcpTransportSchema` | `'stdio' \| 'sse' \| 'http'` | |
| `selfMcpRunIdentitySchema` | `engineAgentId, sessionId, runId, toolCallId` | Bound at propose, required again at decide; a late/forged answer cannot resurrect a stopped/replaced owner. |
| `selfMcpServerInputSchema` | `name/transport?/command?/args/url?/env/headers` (strict) | Mirrors the engine `McpServer`; `env` values must be pure `${NAME}` refs, `headers` fixed templates with one `${NAME}`. |
| `selfMcpProposalSchema` | id, `revision` (CAS counter), agentId, identity, `fingerprint` (sha256 hex), input, transport, `configRevision`, status, createdAt | |
| `selfMcpProposalStatusSchema` | `pending / claimed / applied / rejected / cancelled / uncertain` | `claimed` = in-flight decision; `uncertain` = save hit a moved config. |
| `selfMcpConnectivitySchema` | `connected / needs_credentials / needs_permission / unverified` | |
| `selfMcpDecisionOutcomeSchema` | `{kind:'approved'} \| {kind:'rejected', reason?}` | |
| `selfMcpDecisionRequestSchema` | proposalId, `decisionId` (client-generated, idempotent retries), `expectedProposalRevision`, `expectedConfigRevision`, outcome | |
| `selfMcpDecisionSchema` | durable decision record (identity + fingerprint bound) | |
| `selfMcpReceiptSchema` | outcome `applied / applied_pending_credentials / applied_unverified / rejected / cancelled / failed` + configRevision + detail | Durable operation receipt. |
| `selfMcpDecisionResultSchema` | outcome adds `converged / in_flight` + receipt + `requirements` | |
| `selfMcpReviewSnapshotSchema` | proposal, current configRevision, connectivity, requirements, `conflict {existing, managed, replaces?}`, `alreadyConfigured` | What the review editor renders. |
| `selfMcpProposeRequestSchema` | `{action:'propose', identity, fingerprint, input}` | Engine → UI bridge body. |
| `selfMcpProposeResultSchema` | `proposed / reconciled / conflict / refused` | |
| `selfMcpRequestSchema` | `list / review / decide / dismiss` (discriminated) | Management envelope. |
| `SELF_MCP_GRANT` | `'selfMcpRegister'` (plain literal) | Root adds the id to the grants enum/catalog + master rule. |
| `SELF_MCP_RESERVED_NAME` | `'rerun'` | A model proposal can never take over the engine's bridge name. |
| `selfMcpReservedNameIssue` / `selfMcpNameIssue` | exact `ReservedMcpServerNameError` / `InvalidMcpServerNameError` messages | |
| `selfMcpInputIssue` | strict nonsecret validation: reserved/name first, single destination, no-credential/query/fragment http(s) url, no `${}` in url, env = pure `${NAME}`, header = one-`${NAME}` template, no unrecognized fields | Pure; runs in the engine **and** again at the UI service boundary, before any reservation. |
| `selfMcpProposalInput` | issue → null, else typed parse | |
| `selfMcpResolvedTransport` | explicit → command→stdio → url ends `/sse`→sse else http → default stdio | Mirror of hosted `resolveTransport`. |
| `selfMcpCanonicalInput` | sorted-key canonical JSON (env/headers sorted; args order kept) | Both engine and UI hash this exact string with sha256; the UI recomputes and refuses on mismatch. |

**Exports** consumed elsewhere: `SELF_MCP_GRANT`, `selfMcpInputIssue`, `selfMcpProposalInput`,
`selfMcpResolvedTransport`, `selfMcpCanonicalInput`, `selfMcpRunIdentitySchema`,
`selfMcpProposeRequestSchema`, `selfMcpProposeResultSchema`, `selfMcpRequestSchema`,
`selfMcpDecisionRequestSchema`, `selfMcpReviewSnapshotSchema`, plus every `type` above.

---

## 2. Pipeline

```
engine mcp_register tool (apps/engine/src/desktop/self-mcp/index.ts)
  ├─ snapshot gate: agent.enabled && raw desktopToolGrants?.selfMcpRegister === true
  │                 && selfImprovement.enabled && runId && abortSignal
  ├─ pure validation (selfMcpInputIssue) — before ANY effect
  ├─ withAgentLock → requireDesktopToolGrant(ctx, 'selfMcpRegister')   [fresh, post-revoke]
  ├─ beginDesktopAgentWork
  ├─ fingerprint = sha256(selfMcpCanonicalInput)
  └─ POST loopback bridge (bridge.ts) → /api/desktop/internal/self-mcp
        (Bearer RERUN_API_KEY, bounded, abortable — mirrors desktop/mcp-tools.ts)

UI propose bridge (apps/ui/lib/desktop/server/self-mcp/api.ts handleDesktopSelfMcpBridge)
  └─ authenticateDesktopEngineRequest → service.propose
        ├─ selfMcpInputIssue again
        ├─ authority.ownerOfEngineId(engineAgentId) → local agentId
        ├─ authority.currentOwner → enabled && !deleting && selfImprovement && grant
        ├─ config.managedNames → refuse managed names
        ├─ recompute fingerprint; mismatch → refused
        ├─ config.revision (stored as proposal.configRevision)
        └─ store.reserve (identity+fingerprint reconcile / conflict)
              → proposed / reconciled / conflict / refused

Human review UI (components/desktop/self-mcp + lib/desktop/self-mcp-client.ts + use-self-mcp.ts)
  └─ POST /api/desktop/agents/[agentId]/self-mcp  {action: list|review|decide|dismiss}
        └─ service.review → SelfMcpReviewSnapshot (reconciles uncertain first)
        └─ service.decide → decision.ts decideSelfMcpProposal
        └─ service.dismiss → decision.ts dismissSelfMcpProposal

Trusted decision (apps/ui/lib/desktop/server/self-mcp/decision.ts)
  └─ terminal → converged (same durable receipt); claimed → in_flight; uncertain → recover
  └─ CAS claim (pending→claimed on expectedProposalRevision)
  └─ record decision
  └─ fresh currentOwner (Stop/deletion cancels; never resurrects)
  └─ rejected → claimed→rejected + receipt
  └─ approved:
       config.revision CAS (moved → claimed→pending + failed receipt)
       managedNames → visible requirement, nothing saved
       selfMcpRequirements (sse capability / http availability / localMcpStdio grant) → pending
       http   → fresh owner → probe → save (ok/401/permission) ; probe fail → pending, NOTHING saved
       stdio  → save WITHOUT spawn/install → applied_unverified
       sse    → save WITHOUT probe → applied_unverified (transport owned by G)
  └─ applyServer: fresh owner → config.apply(agentId, server, expectedRevision) (CAS);
       throw (config moved) → claimed→uncertain + failed receipt
```

---

## 3. State transitions & recovery

| Situation | Transition | Result |
| --- | --- | --- |
| propose, first time | → `pending` | card waits in Mac app; no network, no config change |
| propose, same identity + same fingerprint | reconcile | returns existing proposal (`reconciled`) |
| propose, same identity + different body | `conflict` | refused; nothing reserved |
| approve http, probe ok | claimed → probe → save → `applied` | `applied` receipt |
| approve http, 401 | claimed → save → `applied` | `applied_pending_credentials` |
| approve http, needs permission | claimed → save → `applied` | detail: requires permission |
| approve http, probe fails | claimed → `pending` | `failed` receipt; **nothing saved** |
| approve sse w/o G capability / http unavailable / stdio w/o grant | claimed → `pending` | `failed` receipt + visible `requirements`; never silently enabled |
| approve, config moved before save | claimed → `pending` | `failed` receipt (revision CAS) |
| save, config moved during | claimed → `uncertain` | `failed` receipt; reconcile recovers |
| approve managed/protected name | claimed → `pending` | `failed` receipt + requirement |
| reject | claimed → `rejected` | `rejected` receipt; unrelated servers intact |
| dismiss (pending) | → `cancelled` | `cancelled` receipt |
| Stop/deletion mid-decision | claimed → `cancelled` | `cancelled` receipt; no probe/save |
| lost ack, restart | claimed → reconcile | exact server present → `applied` + `applied_unverified` ack (never re-applies); absent → `pending` (restart never auto-approves) |
| racing second tab | claim CAS loses | `in_flight`; retry converges to the settled receipt |
| duplicate decisionId retried | terminal state | `converged` with the same receipt |

Reconcile rules: **live** `claimed` rows are in-flight and are never touched by list/review
(`includeClaimed: false`); `uncertain` rows recover on list/review; root calls
`reconcileSelfMcpProposals(deps, agentId, { includeClaimed: true })` **once at startup** to
recover leftover `claimed` rows from an interrupted session.

---

## 4. Gates (nothing executes on its own)

- Root-injected current-run authority + the default-off per-coworker `selfMcpRegister` grant.
- Existing `config.selfImprovement.enabled` master applies to this tool too (same as
  `selfInstruction`/`verbositySet`).
- No probe/save/config mutation before a human approval; no package install; local executables
  never spawn during preview/review/save; no network is opened merely because the model called
  the tool (proposal touches only the loopback UI service).
- `stdio` saves require the separate `localMcpStdio` grant; `sse` requires G's capability — both
  are visible requirements otherwise.

---

## 5. Owned files (this lane)

```
packages/contracts/src/desktop-self-mcp.ts          canonical contract + helpers
packages/contracts/src/desktop-self-mcp.test.ts     schema/validation regression (needs root vitest wiring, §6.9)
apps/engine/src/desktop/self-mcp/fingerprint.ts     sha256 of canonical input
apps/engine/src/desktop/self-mcp/bridge.ts          loopback propose bridge (Bearer, bounded, abortable)
apps/engine/src/desktop/self-mcp/index.ts           desktopSelfMcpTools(ctx) factory + mcp_register tool
apps/engine/src/desktop/self-mcp/self-mcp.test.ts   gate/validation (run today) + execute-path (describe.skip until §6.2)
apps/ui/lib/desktop/server/self-mcp/fingerprint.ts UI-side sha256 (identical string)
apps/ui/lib/desktop/server/self-mcp/store.ts       SelfMcpStore + createSelfMcpMemoryStore (CAS reserve/claim/transition, decisions, receipts)
apps/ui/lib/desktop/server/self-mcp/adapters.ts    SelfMcpOwner/Authority/ConfigAdapter/ProbeAdapter types
apps/ui/lib/desktop/server/self-mcp/decision.ts    decide/dismiss/reconcile + requirements
apps/ui/lib/desktop/server/self-mcp/service.ts     createSelfMcpService + bindDesktopSelfMcp/getDesktopSelfMcpService (Symbol.for('rerun.desktop.self-mcp.service.v1'))
apps/ui/lib/desktop/server/self-mcp/api.ts         handleDesktopSelfMcp + handleDesktopSelfMcpBridge
apps/ui/lib/desktop/server/self-mcp/test-support.ts fakes (authority/config/probe/store, seedProposal, NOW, fingerprintOf)
apps/ui/lib/desktop/server/self-mcp/service.test.ts
apps/ui/lib/desktop/server/self-mcp/decision.test.ts
apps/ui/lib/desktop/self-mcp-client.ts             browser client (list/review/decide/dismiss/dispose)
apps/ui/lib/desktop/self-mcp-client.test.ts
apps/ui/lib/desktop/use-self-mcp.ts                polling hook (quick while deciding, relaxed otherwise)
apps/ui/components/desktop/self-mcp/SelfMcpReviewCard.tsx      compact card (name/destination/status badge)
apps/ui/components/desktop/self-mcp/SelfMcpReviewEditor.tsx    read-only candidate + approve/reject/cancel
apps/ui/components/desktop/self-mcp/SelfMcpProposalsPanel.tsx  list → editor wiring
apps/ui/components/desktop/self-mcp/SelfMcpReviewCard.test.tsx
apps/ui/components/desktop/self-mcp/SelfMcpProposalsPanel.test.tsx
docs/desktop-round32-h-handoff.md                  this file
```

---

## 6. Exact root wiring

### 6.1 Contracts barrel
`packages/contracts/src/index.ts` — add (alphabetical, near the other `desktop-*` entries):
```ts
export * from './desktop-self-mcp.js'
```

### 6.2 Grant id + catalog
`packages/contracts/src/desktop-tool-grants.ts`:
- line 3 `desktopRerunGrantIds`: append `'selfMcpRegister'` (after `'mcp'`/`'localMcpStdio'`).
- catalog (near the `mcp` entry, line ~67):
```ts
supported('selfMcpRegister', 'Propose MCP servers', 'Allow this coworker to propose MCP servers for human review in the Mac app. Registration and tool execution stay separate decisions: nothing is saved or connected until a human approves the proposal.', 'mcp_register'),
```
⚠️ zod v4 `z.partialRecord(enum, boolean)` **throws** on unknown keys — until this id lands, any
config containing `selfMcpRegister: true` fails to parse. That is exactly why the engine
execute-path tests are `describe.skip` (authored, unrun) and the default stays off pre-wiring.

### 6.3 Engine master rule
`apps/engine/src/desktop/tool-grants.ts` `hasDesktopToolGrant`, next to the self-instruction rule:
```ts
// Proposing an MCP server is a self-improvement action: the same master switch applies.
if (id === 'selfMcpRegister') return config.selfImprovement.enabled
```

### 6.4 Engine tool registration
Wherever `desktopMcpTools(ctx)` is spread into `buildTools` (apps/engine/src/tools/registry.ts),
also spread `desktopSelfMcpTools(ctx)` from `../desktop/self-mcp/index.js`.

### 6.5 UI service bind
`apps/ui/lib/desktop/server/mcp-binding.ts` (startup, where the remote-MCP service binds), over
the **central libsql store** and the mcp-binding authority:
```ts
import { bindDesktopSelfMcp } from './self-mcp/service'
// after the existing service bindings:
bindDesktopSelfMcp({ store: /* libsql SelfMcpStore (6.8) */, authority: /* mcp-binding authority adapter */,
    config: /* config adapter over the central MCP config store */, probe: /* probe adapter over remoteMcpRuntime/local stdio */ })
```
The engine bridge and the management API resolve the same instance via
`getDesktopSelfMcpService()` (`Symbol.for('rerun.desktop.self-mcp.service.v1')`).

### 6.6 Route files (root creates)
```ts
// apps/ui/app/api/desktop/agents/[agentId]/self-mcp/route.ts
import { handleDesktopSelfMcp } from '@/lib/desktop/server/self-mcp/api'
export function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
    return handleDesktopSelfMcp(request, (await params).agentId)
}

// apps/ui/app/api/desktop/internal/self-mcp/route.ts
import { handleDesktopSelfMcpBridge } from '@/lib/desktop/server/self-mcp/api'
export function POST(request: Request) { return handleDesktopSelfMcpBridge(request) }
```

### 6.7 Startup recovery
After each coworker loads at app startup, settle leftover in-flight decisions once:
```ts
await reconcileSelfMcpProposals(decisionDeps, agentId, { includeClaimed: true })
```
(live refreshes keep `includeClaimed` unset — see §3.)

### 6.8 libsql DDL (central store)
Three tables keyed by `(agent_id, id)`; every transition is `UPDATE … WHERE revision = :expected`
(CAS) returning affected rows:
```sql
CREATE TABLE IF NOT EXISTS self_mcp_proposals (
    agent_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
    identity_json TEXT NOT NULL, fingerprint TEXT NOT NULL, input_json TEXT NOT NULL,
    transport TEXT NOT NULL, config_revision INTEGER NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY (agent_id, id)
);
CREATE TABLE IF NOT EXISTS self_mcp_decisions (
    agent_id TEXT NOT NULL, id TEXT NOT NULL, proposal_id TEXT NOT NULL,
    proposal_revision INTEGER NOT NULL, config_revision INTEGER NOT NULL,
    identity_json TEXT NOT NULL, fingerprint TEXT NOT NULL, outcome_json TEXT NOT NULL,
    decided_at TEXT NOT NULL, PRIMARY KEY (agent_id, id)
);
CREATE TABLE IF NOT EXISTS self_mcp_receipts (
    agent_id TEXT NOT NULL, id TEXT NOT NULL, proposal_id TEXT NOT NULL, decision_id TEXT NOT NULL,
    outcome TEXT NOT NULL, config_revision INTEGER NOT NULL, detail TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, id)
);
CREATE INDEX IF NOT EXISTS idx_self_mcp_receipts_proposal ON self_mcp_receipts (agent_id, proposal_id);
```
`reserve` also needs an identity-unique lookup: `(agent_id, engine_agent_id, session_id, run_id,
tool_call_id)` — a unique index over the identity columns (or a small `self_mcp_identity` map
table) with upsert semantics matching `store.reserve` (`created` / `reconciled` on fingerprint
match / `conflict` on mismatch).

### 6.9 Contracts vitest wiring
`packages/contracts` has **no test infrastructure today** (`package.json` has no test script, no
vitest config). Root adds a vitest include (e.g. `vitest.config.ts` with `include:
['src/**/*.test.ts']` and a `test` script) so `packages/contracts/src/desktop-self-mcp.test.ts`
runs. It imports only `vitest` + the module under test.

### 6.10 Next-turn tool discovery (existing surfaces)
Approved servers appear through the existing MCP settings/bridge and next-turn tool build — the
same machinery that surfaces configured HTTPS/stdio servers today. This lane adds **no** new
tool-surface mechanism; status of proposals is read from the review API, not from tool
availability.

---

## 7. Original-source mapping (pinned `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`)

| Pinned original | This lane |
| --- | --- |
| `apps/engine/src/tools/builtin/self.ts` `mcp_register` (input schema, name checks, probe/save flow, refusal prose) | engine `desktop/self-mcp/index.ts` tool + UI `decision.ts`/`service.ts` (proposal instead of save; human decision instead of auto-save) |
| `apps/engine/src/tools/mcp.ts` `resolveTransport` | `selfMcpResolvedTransport` (identical semantics) |
| `apps/engine/src/agents/config-write.ts` `ReservedMcpServerNameError` / `InvalidMcpServerNameError` | `selfMcpReservedNameIssue` / `selfMcpNameIssue` (identical messages) |
| `apps/engine/src/agents/config-write.ts` `mergeMcpServers` upsert | `SelfMcpConfigAdapter.apply` (root maps onto the central store; CAS preserved) |
| `apps/engine/src/desktop/mcp-tools.ts` callbackUrl / callback / abortable / Bearer pattern | engine `bridge.ts` (loopback + Bearer + bounded + abortable) |
| `apps/ui/components/chat/McpServerCard.tsx` (pinned) | `SelfMcpReviewCard.tsx` (compact name/host/transport/status) |
| `apps/ui/components/agent/McpServerEditor.tsx` (pinned) field ordering | `SelfMcpReviewEditor.tsx` (Name → Transport → Command/URL → Args → Environment → Headers; read-only) |

---

## 8. Implemented / dependent / unsupported

**Implemented (owned, authored):** canonical contract + helpers; engine tool with raw snapshot
gate + fresh `requireDesktopToolGrant` + fingerprint + loopback propose bridge; UI service
(propose admission / list / review / decide / dismiss); CAS decision engine with Stop/restart/
deletion races, lost-ack reconcile, duplicate/racing convergence; in-memory store; browser
client; polling hook; compact card, read-only review editor, proposals panel.

**Dependent on root wiring (unrun until then):**
- grants enum id + catalog + engine master rule (§6.2, §6.3) — unblocks the engine fresh check
  and config parse of `selfMcpRegister: true`; engine execute-path suite (`describe.skip`).
- `bindDesktopSelfMcp` over the central libsql store + authority/config/probe adapters (§6.5)
  — the memory store and fakes are test-only.
- two route files (§6.6); `desktopSelfMcpTools` spread in `buildTools` (§6.4).
- startup `reconcileSelfMcpProposals(includeClaimed: true)` (§6.7).
- contracts vitest include (§6.9).
- panel mounting in the desktop settings/agent UI is root's (this lane ships the component).

**Unsupported / explicitly out of scope:**
- Package install / npm (`tool_install` style) — the proposal describes a command but the human
  decision never spawns or installs anything.
- Model auto-approval or auto-execution; any network opened by the model call alone.
- SSE transport execution — G's capability owns it; without it the decision cannot enable it.
- Parallel approval/credential/permission systems; live Keychain/credential access; the engine
  resolving `${NAME}` references (engine-side resolution is the existing mcp machinery).

---

## 9. Regressions (authored, unrun)

- `packages/contracts/src/desktop-self-mcp.test.ts` — strict schema/secret exclusion, name rules,
  reserved name, transport resolution, canonical fingerprint stability. Needs §6.9.
- `apps/engine/src/desktop/self-mcp/self-mcp.test.ts` — default-off gate, master switch, disabled
  coworker, run requirements, validation refusals with `fetch` never called (run today);
  `describe.skip` execute-path: happy propose, reconcile, conflict, refused, revoked-grant stale
  call, unavailable bridge (post §6.2/§6.3).
- `apps/ui/lib/desktop/server/self-mcp/service.test.ts` — propose admission/refusals, managed
  names, fingerprint tamper, reconcile/conflict, transport auto-detect, no probe/save before
  approval, list/review snapshots (requirements, connected/conflict, 404), live-claimed untouched.
- `apps/ui/lib/desktop/server/self-mcp/decision.test.ts` — approve http happy/401/permission/
  probe-fail-no-save, unsupported transport + sse/stdio requirements never spawn, reject leaves
  unrelated servers, duplicate→converged, racing tabs→in_flight→converged, late decision on
  deleted owner→cancelled, stale proposal/config revision, managed at decide, Stop mid-flight,
  mid-save config change→uncertain→reconcile→pending, lost-ack present→applied ack / absent→
  pending, startup `includeClaimed` recovery, dismiss cancel/converge/stale/404.
- `apps/ui/lib/desktop/self-mcp-client.test.ts` — envelopes, error surfacing, disposed client.
- `apps/ui/components/desktop/self-mcp/SelfMcpReviewCard.test.tsx` + `SelfMcpProposalsPanel.test.tsx`
  — happy-dom, hand-rolled render/screen/fireEvent (DesktopCoworkerMcp harness style): list→open,
  approve/reject/cancel envelopes with CAS revisions, busy disable during in-flight decision,
  visible requirement, card rendering.

---

## 10. Honest safety / recovery limits

- The store in tests is in-memory; durability, CAS atomicity and restart recovery depend on
  root's libsql implementation (§6.8) — nothing here substitutes for it.
- `SelfMcpAuthority`/`SelfMcpConfigAdapter`/`SelfMcpProbeAdapter` are interfaces; real probing
  behavior (401 vs permission vs network), credential resolution and configuration CAS are root's
  implementation over the mcp-binding stores. Tests exercise the decision logic with fakes.
- stdio/sse saves are `applied_unverified`: no connectivity claim is made without root's probe.
- Engine execute-path tests remain unrun until the grants wiring lands; the default-off
  pre-integration behavior is covered by the factory-gate tests that run today.
- Fingerprint equality is shared-hash, not a signature; a tampered payload is caught by
  recomputation in the UI service, and identity/fingerprint are bound into every decision, but
  the transport (engine loopback, session/engine Bearer) is the existing desktop trust boundary.
- No acceptance claims: root runs typecheck, lint, tests, build, install, server/app/network/
  Docker/Mac QA and fixes defects.
