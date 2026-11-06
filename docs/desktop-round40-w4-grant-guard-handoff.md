# RD40 W4 external update_agent grant-guard handoff

**Kind:** narrow source repair for confirmed external MCP permission bypass — **not** RD40 complete, **not** accepted, **not** tested.  
**Branch:** `desktop/round38-master-completion`  
**Worktree:** `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round38-master-completion`  
**Frozen audit base:** `6f6ad959a09abaf1947950b6f82413c94407e22a` (`desktop/rd38-cloud-base`)  
**Original comparison pin:** `2a57fa6dd53311f763bfc9abde85997b7f7e5309` (present; not an ancestor of desktop HEAD; read-only)  
**Parent tip before this impl:** `92dc02509cd9a3069bb588b39da6f3e6f6184bba`  
**Impl SHA:** `73b6855e6d227011fcd6198ce3ee71f1d640a94c`  
**Audit artifact (untrusted until verified):** box store `…/assets/01M6S6Z5RSZHQX92H233BR0AH0.md` (cloud RD40 read-only audit)

## Verification before change

On master tip `92dc0250…` (clean):

- `invokeExternalMcpOperation` `update_agent` assigned `args.tools` / `args.selfImprovement` into the engine `patchAgent` body.
- Engine `apps/engine/src/http/routes/agents.ts` `PATCH /:id` merges `tools.desktopToolGrants`, `tools.desktopWorkspaceRead`, `tools.desktopCodexGrants`, and `selfImprovement`.
- `assertNativeChangeAllowed` (`native-grants.ts`) only gates Codex capability changes during an active Codex run — not Rerun grants, not idle external patches.
- `create_agent` already refused `tools` / `selfImprovement` (and model/connection keys) before create; catalog copy still advertised configuring tools via `update_agent`.
- Scope map unchanged: `update_agent` requires `coworkers:write` (`EXTERNAL_MCP_TOOL_SCOPES`); `mcp:read`-only keys never reach the tool via catalog/bridge.

## What changed (adapter only)

| Path | Change |
|---|---|
| `apps/ui/lib/desktop/server/external-mcp-tools/operations.ts` | Exported `EXTERNAL_MCP_AGENT_AUTHORITY_FIELDS` + `assertExternalMcpAgentMetadataOnlyUpdate`. Called at the **start** of `update_agent` before rename / Box move / `patchAgent`. Removed `tools`/`selfImprovement` from the update patch builder (defense in depth). Honest `create_agent` refusal copy; stopped copying refused tools/selfImprovement into post-create patch. |
| `apps/ui/lib/desktop/server/external-mcp-tools/catalog.ts` | `create_agent` description suffix no longer claims tool grants can be set via `update_agent`. |
| `apps/ui/lib/desktop/server/external-mcp-tools/operations.test.ts` | Authored **unrun** regressions (not executed). |

### Denied authority fields (whole request rejected)

Top-level presence of any of: `tools`, `selfImprovement`, `mcpServers`, `desktopToolGrants`, `desktopCodexGrants`, `desktopWorkspaceRead`.

- Rejects mixed metadata+grant patches with explicit unsupported receipt (`no changes were applied`); **no partial updates**.
- Top-level `tools` covers nested `desktopToolGrants` / `desktopCodexGrants` / `desktopWorkspaceRead` (canonical engine merge shape under `tools`).
- Uses the exported constant list — not a second schema / unbounded scan.

### Still permitted on `update_agent`

`name`, `description`, `soul`, `handle`, `spaceId` (Box move), `verbosity`, `connectionId`, `model`, `provider` — plus existing principal / workspace-owned agent / guarded runtime checks.

### Explicitly unchanged (root / other owners)

- No edits to `apps/engine/src/http/routes/agents.ts`, `native-grants.ts`, contracts barrel, migrations, global registries, or key scopes.
- No broadening of `coworkers:write` or default-off grants.
- No central mounts / DesktopApp wiring.
- Candidates 2–5 (Claude relogin truthfulness, native nontext receipt, clear-all vector residue, search rotated-key classification) **not** implemented this checkpoint — recorded in RD42 docs only.
- Prior RD39 C7 decision preserved: keep native notification channel; do not remove `bridge.notify`.

## Typed interfaces used (existing)

- `ExternalMcpCallContext` / `ExternalMcpPrincipal` / scopes from `@rerun/contracts` (`desktop-external-mcp.ts`).
- Engine client `patchAgent` / `getAgent` (unchanged signatures).
- Local helper types: `ExternalMcpAgentAuthorityField`, `EXTERNAL_MCP_AGENT_AUTHORITY_FIELDS`.

## Authored unrun regressions (sources only — not run)

In `operations.test.ts`:

1. Allow metadata/Box/model fields through the assert helper.
2. Deny each authority field + mixed metadata+grant (message lists fields; “no changes were applied”).
3. `update_agent` rejects before rename/move/`patchAgent` (mocks assert zero mutation).
4. Allowed metadata-only `update_agent` still patches description/soul/handle without `tools`/`selfImprovement`.
5. `create_agent` still refuses `tools` before create write.
6. Read-only / sibling note: authority assert fails closed independently; `mcp:read` scope gate remains catalog/bridge-owned (`update_agent: coworkers:write`).

## Status

| Claim | Value |
|---|---|
| Source repaired on master | **yes** at `73b6855e…` |
| Tests executed | **no** |
| Typecheck/lint/build/install | **no** |
| Live key / listener / fixture | **no** |
| Root / Mac acceptance | **not accepted** |
| Checklist mutation | **none** |
| Push / PR | **none** |

## Root follow-up

- Run the colocated vitest cases when execution is authorized.
- Disposable `coworkers:write` key + default-off grants: confirm unsupported receipt and grants remain false after restart; sibling coworker + `mcp:read` key unchanged (matrix row W4-G1).
