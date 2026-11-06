# Round36 C — external MCP catalog handoff

Branch `desktop/round36-external-mcp-tools`. Continuation authorized on existing worktree (scoping HEAD was `5af023dda412a21f77dec9ea86a66f2cabf72286`, clean). Prior inventory + five-read commits preserved. **No tests, typecheck, lint, builds, installs, servers, network/provider calls, Docker, UI, Keychain, live databases, or restart checks were executed.** No push/merge/activation. No installed acceptance claimed.

## Published dependents (read-only)

| Contract | SHA | Notes |
| --- | --- | --- |
| B external-mcp v1 | `9e81e11110e09aeb05266068c332b44fdee38496` | `packages/contracts/src/desktop-external-mcp.ts` — principal, scopes, call context, dispatch port, receipts. C does not invent a second principal. |
| Root workspaces v1 | `052f6f66f8f8eaca27d5ea878d2cf3024e617dc0` | Native workspace identity; prepared `DesktopRuntime.workspaceId` remains literal `1`. |
| Reviewed original | `2a57fa6dd53311f763bfc9abde85997b7f7e5309` | Account tools + mcp-account.service callers. Historical baseline `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. |

## Owned paths changed this continuation

- `apps/engine/src/desktop/external-mcp-tools/dispatch.ts` — full `createExternalMcpDispatch` (reads + scoped effects); `createExternalReadDispatch` retained.
- `apps/engine/src/desktop/external-mcp-tools/dispatch.test.ts` — revoke/cancel/oversize/scope/listTools regressions (authored, unrun).
- `apps/ui/lib/desktop/server/external-mcp-tools/catalog.ts` — bound tool → B scope map and registrations from `ACCOUNT_TOOL_DEFS`.
- `apps/ui/lib/desktop/server/external-mcp-tools/guard.ts` — live recheck + runtime/workspace/agent ownership fences.
- `apps/ui/lib/desktop/server/external-mcp-tools/operations.ts` — concrete local authority bindings for all bound tools.
- `apps/ui/lib/desktop/server/external-mcp-tools/factory.ts` — `createLocalExternalMcpTools({ recheck, services? })`.
- `apps/ui/lib/desktop/server/external-mcp-tools/reads.ts` — historical entry now delegates to full factory.
- `apps/ui/lib/desktop/server/external-mcp-tools/inventory.ts` — original→implemented|dependent|unsupported matrix + counts.
- Authored unrun regressions: `inventory.test.ts`, `catalog.test.ts`, `operations.test.ts`.
- This handoff.

## Catalog status matrix

Original `ACCOUNT_TOOL_DEFS` = 37 agent-domain + 4 share + 12 template = **53**.

| Status | Count (services unbound) | Count (services injected) | Notes |
| --- | ---: | ---: | --- |
| implemented | 34 | 37 | Bound to local authorities below |
| dependent | 3 | 0 | `list_agent_connectors`, `attach_connector`, `detach_connector` need `ExternalMcpServicesAuthority` |
| unsupported | 16 | 16 | Share + template tools — not registered |

### Exact canonical bindings

| Tool | Scope | Local authority |
| --- | --- | --- |
| list_spaces | mcp:read | `readDesktopBoardState` + roster counts |
| list_agents / get_team_status / get_agent | mcp:read | `listDesktopAgents` / `findDesktopAgent` + `getAgent` / `listRuns` / schedules+triggers when granted |
| create_agent | coworkers:write | `planDesktopAgentPlacement` (+ board `create` when needed) → `createDescribedDesktopCoworker` (durable `requestId`=B request id, kickoff from soul/description) → optional `patchAgent` |
| update_agent | coworkers:write | `renameDesktopCoworker`, board `move-agent`, `patchAgent` |
| delete_agent | coworkers:write | `deleteDesktopCoworker` with typed current name after `confirm: true` |
| list_ai_connections / set_default_model | mcp:read / coworkers:write | `readDesktopProviders` / `changeDesktopSettings({action:'default'})` |
| list/get/read skill + upsert/delete | mcp:read / coworkers:write | `coworker-skills` confined store; update requires directory `identity` |
| schedules list/upsert/run/delete | mcp:read / schedules:write | `authorizeDesktopSchedules` + engine schedule client; run uses `x-desktop-schedule-request-id`=B request id |
| triggers list/upsert/test/rotate/delete | mcp:read / triggers:write | `authorizeDesktopTriggers` + `desktopTriggerEngine` (`fire` for test; tokens stripped from list projection except rotate/create responses that intentionally return URL) |
| send_message / list_runs / get_run | runs:send / mcp:read | `startDesktopChat` with `requestId`; drain SSE; poll `getRun` statuses `done\|error\|cancelled`; `desktopRunView` |
| tables query/execute (agent + space) | mcp:read / data:write | `agentDataBase` / `SPACE_DATA_BASE` via `queryDb`/`executeDb`/`listDbTables` after roster/Box checks |
| search/list connectors | mcp:read | `listDesktopServiceCatalog` (bundled catalog; no secrets) |
| list/attach/detach agent connectors | mcp:read / connectors:write | **Dependent** — `ExternalMcpServicesAuthority` DI from root `LocalServices` |

Share/template tools: **unsupported**; never advertised.

## Hard missing authorities / limitations

1. **Engine↔UI external-tools bridge (root-owned).** B registers `ExternalMcpDispatchPort` in the engine process; roster/skills/schedules/triggers/chat live in the UI server. Root must mount an authenticated internal bridge (existing custody primitives: engine `desktop/internal-client.ts:desktopInternalJson`, UI `server/auth.ts:authenticateDesktopEngineRequest`) that forwards `listTools`/`callTool` + cancellation. No URL/header invented here.
2. **Contracts barrel.** Root must export B’s `desktop-external-mcp` from `@rerun/contracts` before resolution.
3. **Services DI.** Pass `services: ExternalMcpServicesAuthority` into `createLocalExternalMcpTools` or connector install tools stay unadvertised (fail closed).
4. **Runtime workspace literal 1.** Principal workspace must equal live runtime (`workspaceId`/`launchNonce`); multi-workspace create remains blocked on prepared runtime.
5. **create_agent** requires soul or description as Mac durable kickoff; connectors-on-create refused (use attach after).
6. **set_default_model** uses `coworkers:write` (no dedicated models scope in B v1).
7. **Trigger list** strips raw `token` field; URL may still appear on management projections when the engine includes it — treat as secret.
8. **No ambient credentials.** Factory never reads Keychain or HTTP session cookies; services mutate only through injected port.

## Root activation fragments (do not apply from C)

After B storage init + contracts export:

```ts
// UI server (authenticated internal only)
import { createLocalExternalMcpTools } from '@/lib/desktop/server/external-mcp-tools/factory'
import type { ExternalMcpServicesAuthority } from '@/lib/desktop/server/external-mcp-tools/operations'

const services: ExternalMcpServicesAuthority | undefined = /* root wires LocalServices.list/mutate */
const tools = createLocalExternalMcpTools({ recheck: canonicalExternalLiveCheck, services })
// Bind `tools` into root's engine↔UI bridge implementing ExternalMcpDispatchPort.
```

```ts
// Engine process
import { registerExternalMcpDispatch } from './external-mcp-authority/dispatch.js'
registerExternalMcpDispatch(canonicalUiExternalToolsBridge)
```

`canonicalExternalLiveCheck` must call B `recheck` with the exact live-check fields (full scope set equality). B owns effect receipts/fingerprints/lost-ACK around `callTool`; C rechecks before/after every domain await and passes B `requestId` into durable local mutations (create/delete/schedule run/trigger mutate/services mutate).

## Authored regression coverage (unrun)

- Dispatch: revoke-during-await, cancel, oversize, mixed-scope recheck, missing write scope, invalid scope/effect.
- Catalog/inventory: original order, unsupported share/templates, dependent connectors, count identity.
- Operations: confirm helpers; connector fail-closed without services; attach requestId + authMethodId when bound.

Root runs every check and repairs findings.

## Final tip (implementation commit)

_Implementation SHA filled in follow-up doc commit once._

Status after C commits: report clean/dirty externally. W4 / native / restart acceptance remain root-owned. This package does **not** claim all A–H complete.
