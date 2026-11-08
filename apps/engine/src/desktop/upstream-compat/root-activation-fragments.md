# Root activation fragments — Round37 Agent I (upstream-compat)

These fragments are **not applied** by this agent. Root composes them. No migration is required for this package.

## 1. Codex unknown `codexErrorInfo` passthrough (required for fake-app-server regressions)

- Source fragment: `apps/engine/src/desktop/upstream-compat/codex-errorinfo-passthrough.fragment.patch`
- Target shipped patch: `apps/engine/patches/ai-sdk-provider-codex-cli@1.3.1.patch` (compose; do not replace)
- Package: `ai-sdk-provider-codex-cli@1.3.1` via `pnpm.patchedDependencies`
- Preserve: every existing Mac hunk; `pnpm.overrides` `@openai/codex` `0.166.0`; reasoning/auth/image/attachment/execution-permission behavior
- After compose: refresh install so the patched package is live, then run `apps/engine/src/desktop/upstream-compat/codex-app-server-errors.test.ts`

## 2. Claude consumer turn-order (already live for engine loop; optional explicit adapter)

Engine loop already calls `turnOrder(provider, model)` from `apps/engine/src/agents/turn-order.ts` (`apps/engine/src/runtime/loop.ts`). Card tools already use `cardCallTiming`.

Optional explicit import for a Claude-specific caller without editing the bundled runner:

```ts
import { decideTurnOrder, claudeCardCallTiming } from '../desktop/upstream-compat/turn-order-adapters.js'
// or from '../../agents/turn-order.js' for turnOrder / cardCallTiming directly
```

Do **not** change Claude subscription login or the bundled Claude Code runner in this slice.

## 3. Generic MCP consumer (`mcpToolSet`) — extract shared helper (optional cleanup)

`mcp-relay.ts` already normalises via `modelReadyMcpTools`. `mcpToolSet` in `apps/engine/src/tools/mcp.ts` still inlines `toToolInputSchema`. Optional root cleanup (not required for relay correctness):

```ts
import { modelReadyMcpTool } from '../desktop/upstream-compat/model-ready-mcp-tool.js'
// inside mcpToolSet:
const t = modelReadyMcpTool(serverName, original)
set[mcpToolNameFor(undefined, serverName, t.name)] = dynamicTool({ ... })
```

## 4. Tool-name repair consumer

Already wired: `apps/engine/src/runtime/loop.ts` → `experimental_repairToolCall: repairToolCall`.
No additional mount. Preserve per-coworker grants, execution-time rechecks, tool-call IDs and Cancel/Stop authority — this repair only renames to an enabled ToolSet key or strips nulls.

## 5. OpenCode Provider enum / `opencodeUpstreamId` (dependent on A/C)

`turn-order.ts` locally strips `go/` and `console/` when `(provider as string) === 'opencode'`. Root/A/C must add `opencode` to `providerSchema` and may replace the local strip with contracts `opencodeUpstreamId` once exported. Until then, OpenCode remains **dependent / unregistered**.

## 6. No database / data-dir migration

This package is pure protocol helpers + candidate patch fragment. Do not append `DATA_DIR_MIGRATIONS` / DB ladders for Round37 I.
