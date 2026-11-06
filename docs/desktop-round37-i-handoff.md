# Round 37 Agent I — Upstream provider/tool protocol compatibility handoff

**Implementation commit (source + authored regressions only):** `e0b47c7da5fed883e55c1fdbfce65deea0ee4660`  
**Branch:** `desktop/round37-runtime-compatibility`  
**Prepared base:** `e87edabffded9b56c67f98539a412e230959435c` (runtime `81f1c62a7b9fb0ac1f44bbee77c21e0f4aa576f5`)  
**Reviewed upstream pin:** `2a57fa6dd53311f763bfc9abde85997b7f7e5309`  
**Historical design pin:** `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`  

**Checks executed:** none (no tests, typecheck, lint, build, install, servers, fixtures, provider/network, Docker, UI, Keychain, or restart).  
**Installed / Mac acceptance:** not claimed.  
**Push / merge / deploy:** not performed.  
**Round36 handoffs:** untouched and not integrated by this package.  
**Dependent-agent contract revision required:** none for A–H Round36; OpenCode Provider/`opencodeUpstreamId` remains an A/C + contracts dependency (see matrix).

This document records the implementation SHA above. The final tip SHA after this handoff commit is reported in the agent reply, not chased inside this file.

---

## Original source / design mapping

| Capability | Upstream (`2a57fa6…`) | Mac before this package | This package |
|---|---|---|---|
| Unknown `codexErrorInfo` passthrough | `apps/engine/patches/ai-sdk-provider-codex-cli@1.3.1.patch` (small patch: string + `{}` passthrough arms) + `agents/codex-app-server-errors.test.ts` + `__fixtures__/fake-codex-app-server.mjs` | Larger desktop patch **lacks** the errorInfo arms; keeps effort/summary/code-mode/MCP callId/images/permissions/reasoning | Candidate fragment only under `desktop/upstream-compat/codex-errorinfo-passthrough.fragment.patch`; fixtures + real-boundary regressions authored; **shipped patch not edited** |
| Claude / GPT turn order | `agents/turn-order.ts` call-first for Codex, Claude providers, GPT/`claude-` model ids; OpenCode plan strip; card copy mentions card still shows below | Call-first only for Codex + GPT regex; Claude was message-first; shorter card copy | Ported into owned `agents/turn-order.ts` + tests; pure adapters in `upstream-compat/turn-order-adapters.ts` |
| MCP root-union normalisation for CLI relay | `tools/mcp-relay.ts` → `modelReadyMcpTool` → `toToolInputSchema` | `mcp-schema.ts` / inline `mcpToolSet` already normalised for engine-driven tools; **relay listed raw schemas** | `modelReadyMcpTool(s)` in `upstream-compat`; `mcp-relay.ts` lists normalised tools without mutating catalog |
| Tool-name repair for CLI-prefixed names | `runtime/tool-repair.ts` `loopToolNameFor` + `NoSuchToolError` path restricted to ToolSet keys | Null-strip only | Full upstream repair port in owned `runtime/tool-repair.ts` |

---

## Implementation inventory (changed paths)

### Owned implementation
- `apps/engine/src/agents/turn-order.ts`
- `apps/engine/src/agents/turn-order.test.ts`
- `apps/engine/src/runtime/tool-repair.ts`
- `apps/engine/src/runtime/tool-repair.gaps.test.ts` (colocated regression expansion)
- `apps/engine/src/tools/mcp-relay.ts`
- `apps/engine/src/tools/mcp-relay.test.ts` (colocated; now expects root-union lift)
- `apps/engine/src/desktop/upstream-compat/**` (new)
  - `model-ready-mcp-tool.ts` (+ test)
  - `turn-order-adapters.ts` (+ test)
  - `index.ts`
  - `codex-errorinfo-passthrough.fragment.patch`
  - `codex-app-server-errors.test.ts`
  - `root-activation-fragments.md`
  - `__fixtures__/fake-codex-app-server.mjs` (original)
  - `__fixtures__/fake-codex-app-server-known-error.mjs`
  - `__fixtures__/fake-codex-app-server-interrupted.mjs`
  - `__fixtures__/fake-codex-app-server-malformed.mjs`

### Explicitly not changed
- Shipped `apps/engine/patches/ai-sdk-provider-codex-cli@1.3.1.patch`
- `package.json` / lockfiles / manifests / provider enums / contracts barrel
- Generic `apps/engine/src/tools/mcp.ts` (still inlines schema note for `mcpToolSet`; fragment offered)
- Bundled Claude/Codex runners, login paths, supervisor, preload/IPC, DB/data-dir migrations
- Round36 packages / central DesktopApp / checklist

---

## Public adapters / exports

From `apps/engine/src/desktop/upstream-compat/index.ts`:
- `modelReadyMcpTool`, `modelReadyMcpTools`
- `decideTurnOrder`, `claudeCardCallTiming`, `TurnOrderDecision`

From owned modules already consumed by the engine:
- `turnOrder`, `cardCallTiming`, `answeringModelId` — `agents/turn-order.ts` (loop + HITL/card descriptions already import these)
- `repairToolCall`, `repairNullToolInput`, `loopToolNameFor` — `runtime/tool-repair.ts` (already `experimental_repairToolCall` in `runtime/loop.ts`)
- `relayMcpServer`, `withPooledRelays` — `tools/mcp-relay.ts` (already used by loop/providers)

**Dependent contract revisions published by this package:** none. No new contracts file; no barrel change.

---

## Consumer activation order (root)

Exact fragments: `apps/engine/src/desktop/upstream-compat/root-activation-fragments.md` and the patch file beside it.

1. **Compose** `codex-errorinfo-passthrough.fragment.patch` into the existing shipped `ai-sdk-provider-codex-cli@1.3.1` patch (locate `codexErrorInfoSchema` in both `dist/index.cjs` and `dist/index.js`; append `string` + `object({}).passthrough()` arms). Preserve every Mac hunk and Codex `0.166.0` override.
2. Refresh pnpm patched dependency install so the composed patch is what `createCodexAppServer` loads.
3. Run authored `upstream-compat/codex-app-server-errors.test.ts` against the **real** provider boundary (fixtures are fake app-servers; do not mock SDK success).
4. Engine turn-order / repair / relay callers are already mounted; no router or migration step.
5. Optional: refactor `mcpToolSet` to call `modelReadyMcpTool` (cleanup only).
6. When A/C registers OpenCode: add `opencode` to `providerSchema` and optionally swap local plan-strip for contracts `opencodeUpstreamId`.

**Migration:** none required.

---

## Supported / dependent / unsupported matrix

| Item | State | Notes |
|---|---|---|
| Claude + Anthropic provider call-first ordering | **Implemented** (source) | Live once this branch is integrated; loop already calls `turnOrder` |
| GPT / Codex call-first (pre-existing) | **Implemented** | Preserved |
| Card timing copy (“card still shows below…”) | **Implemented** | HITL/card tools already interpolate `cardCallTiming` |
| OpenCode plan-strip + Provider | **Dependent** | Local strip ready; Provider enum / contracts export / A–C adapter missing |
| MCP relay root `anyOf`/`oneOf`/`allOf` lift | **Implemented** (source) | Uses existing `toToolInputSchema`; catalog immutable |
| Generic `mcpToolSet` shared helper extraction | **Dependent** (optional) | Behavior already present inline in `mcp.ts` |
| Null input repair | **Implemented** (pre-existing, preserved) | |
| CLI/bridge tool-name repair to enabled ToolSet only | **Implemented** (source) | Cannot activate disabled/unknown via case/punct/typo |
| Unknown Codex `codexErrorInfo` passthrough | **Dependent** | Candidate fragment authored; root must compose shipped patch |
| Fake-app-server error regressions | **Authored, unrun** | Require composed patch + root test run |
| Credential migrations, cron, external MCP service, remote-machine, EE modules | **Unsupported / out of scope** | Explicitly excluded |
| Silent provider fallback / fabricated tool results | **Unsupported** | Not introduced |

---

## Persistence / recovery / identity

Protocol helpers only. No new durable store. Repair preserves `toolCallId` and only swaps `toolName`/`input` when an enabled tool matches. Relay does not mutate pooled catalog objects. Reads/listings are observational. Cancel/Stop and per-coworker grant rechecks remain outside this package (unchanged loop/grants authority).

---

## Authored-but-unrun regression scenarios

1. `agents/turn-order.test.ts` — OpenCode plan strip (cast), Claude call-first, GPT call-first, message-first others, card visibility copy, repeated timing identity.
2. `desktop/upstream-compat/turn-order-adapters.test.ts` — adapter decisions for Claude vs Google.
3. `runtime/tool-repair.gaps.test.ts` — null rewrite, unknown tool leave-alone, Claude/Codex/connector renames, missing enabled tool, case/punct denial, toolCallId preservation.
4. `runtime/tool-repair.test.ts` — existing null-strip unit cases (unchanged file).
5. `tools/mcp-relay.test.ts` — root oneOf/anyOf lift, nested union keep, call passthrough/errors, catalog immutability.
6. `desktop/upstream-compat/model-ready-mcp-tool.test.ts` — immutability, nested/$ref keep, malformed/oversized roots, catalog list identity.
7. `desktop/upstream-compat/codex-app-server-errors.test.ts` — unknown string errorInfo, known object kind, interrupted+replay, malformed object kind via real `createCodexAppServer` + fixtures (**requires root patch composition first**).

---

## Known limits / honest caveats

- Unbound ports are not production capabilities: unknown Codex errorInfo remains **dependent** until root composes the fragment.
- OpenCode is prepared in turn-order only via string cast / local plan prefix; it is not a registered Mac provider.
- Fake-app-server tests will hang or fail against today’s shipped patch until the errorInfo arms exist — that is the regression they are meant to catch after composition.
- `systemPrompt.order.test.ts` derives order from `turnOrder()` and should follow Claude call-first automatically after integration; root still owns execution.
- Nested schema combinators inside properties are intentionally left intact (original `toToolInputSchema` root-only lift). No deep $ref walker / cycle breaker was invented beyond original semantics.
- This agent did not run any execution checks and does not mark checklist groups complete.
