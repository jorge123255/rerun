# Desktop self-instruction controls (E7 slice)

Port of the hosted "Improve itself" self-improvement controls onto the Mac coworker's **Tools** settings. Slice scope: the master switch plus the **own-instruction** and **reply-length** permissions — only `soul_update` and `verbosity_set`, each explicitly opt-in per coworker and rechecked at execution.

## Original source mapping

Ports from commit `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

| Hosted original | Ported here |
| --- | --- |
| `AgentPanelTools.tsx` `CAPABILITY_META.self` "Improve itself" card + master switch + nested `SELF_IMPROVEMENT_SUBKEYS` list | `DesktopCoworkerTools.tsx` `SelfImprovementCard`: "Improve itself" card, master switch, nested **Edit own instructions** / **Change reply length** rows (nested controls shown only while the master is on) |
| `AgentPanelTools.tsx` master toggle → `updateAgentConfigAction({ selfImprovement: { enabled } })` | Tools `PATCH` for row `self` → `selfImprovement.enabled` |
| `builtin/self.ts` `soul_update` (gated by `allowSoulEdit`) | `apps/engine/src/desktop/self-instruction.ts` `soul_update`, gated by the `selfInstruction` grant + the master, rechecked at execution |
| `builtin/self.ts` `verbosity_set` (exposed with the self family) | `apps/engine/src/desktop/self-instruction.ts` `verbosity_set`, gated by the `verbositySet` grant + the master, rechecked at execution |

The hosted `builtin/self.ts`, `tools/catalog.ts` self family and the hosted Agent panel are untouched. Desktop builds the tool set from `apps/engine/src/desktop/*` modules only, so none of the hosted `selfTools` (package install, MCP register/login, sign-in, auto-memory curation) is imported into the Mac runtime.

## How the permissions are stored

| Setting | Config field | Change path |
| --- | --- | --- |
| Master "Improve itself" | `selfImprovement.enabled` (existing) | Tools `PATCH { group: 'rerun', id: 'self' }` |
| "Edit own instructions" | `tools.desktopToolGrants.selfInstruction` (new grant id) | Tools `PATCH { group: 'rerun', id: 'selfInstruction' }` |
| "Change reply length" | `tools.desktopToolGrants.verbositySet` (new grant id) | Tools `PATCH { group: 'rerun', id: 'verbositySet' }` |

Both grants are part of `desktopRerunGrantIds`, so they follow the existing desktop allowlist / owner binding / serialization / run-time-grant pattern (`desktopRerunGrantsOf`, `hasDesktopToolGrant`, `requireDesktopToolGrant`). `hasDesktopToolGrant` composes each grant with the master: the grant alone is never enough while "Improve itself" is off, and `requireDesktopToolGrant` re-reads the current config at execution, so a tool built before a toggle is refused once the permission is revoked.

## Defaults

- `selfImprovement.enabled` defaults to `true` (unchanged engine default).
- `selfInstruction` / `verbositySet` grants default to **off** for every existing and new coworker (missing key → `false`), so the two tools are not exposed until the coworker opts in.
- Nested controls are hidden while the master is off and appear in the "Unavailable tools" disclosure with the reason "Turn on Improve itself to change this permission."; the `PATCH` for a nested permission is refused (400) while the master is off.

## Preserved behavior

- **autoMemory stays a separate saved preference** (`selfImprovement.autoMemory`, set in Edit coworker → Learn from replies). The master toggle patches only `selfImprovement.enabled` and the engine merges `selfImprovement` partially, so switching Improve itself off and on never erases `autoMemory` (or `allowSoulEdit`).
- **Manual instructions editing keeps working**: the settings route (`/settings` `PATCH` with `soul`) writes `SOUL.md` unconditionally, independent of the master or grants.
- **Reply length** stays one field: Edit coworker's segmented control and `verbosity_set` both write `config.verbosity`.
- **Sibling isolation**: every change is routed through the per-coworker engine PATCH, which merges `desktopToolGrants` and `selfImprovement` partially, so unrelated grants, tools switches and config fields are preserved.
- **Restart persistence**: everything lives in the existing agent `config.json` (plus `SOUL.md` for instruction edits); no data-dir migration was needed (the new ids extend the existing `desktopRerunGrantsSchema` enum; old configs read as off).

## Engine wiring

- `apps/engine/src/desktop/self-instruction.ts`: `desktopSelfInstructionTools(ctx)` — `soul_update` writes `SOUL.md` + `reloadAgent`; `verbosity_set` writes `config.verbosity` under the per-agent lock + `reloadAgent`. Each starts with `requireDesktopToolGrant`.
- `apps/engine/src/tools/registry.ts`: the desktop branch now also spreads `desktopSelfInstructionTools(ctx)`.
- `apps/engine/src/desktop/tool-grants.ts`: `hasDesktopToolGrant` gates `selfInstruction`/`verbositySet` on the master.
- `apps/engine/src/agents/systemPrompt.ts`: the verbosity note advertises `verbosity_set` only when the desktop `verbositySet` grant is actually granted; `desktopToolInstruction` lists `soul_update`/`verbosity_set` when their grants are on.
- The Codex bridge (`providers.ts` `allowed` set) picks up the two tool names automatically from the catalog rows, so granted tools are also callable from a native Codex run.

## UI

- `DesktopCoworkerTools.tsx`: `SelfImprovementCard` renders the "Improve itself" card (master switch) and, while on, the nested **Edit own instructions** and **Change reply length** switches; master-off nested rows move to the "Unavailable tools" disclosure.
- `apps/ui/app/api/desktop/agents/[agentId]/tools/route.ts`: maps `self` → `selfImprovement.enabled`, `selfInstruction`/`verbositySet` → `desktopToolGrants`, recomputes availability and enabled state for every row, refuses enabling a nested permission while the master is off.

## Regression tests (authored, unexecuted by this lane)

- `apps/engine/src/desktop/self-instruction.test.ts` — opt-in exposure, sibling isolation, master-off withdrawal, stale-call refusal, `SOUL.md` rewrite, verbosity-only change, master toggles preserve `autoMemory` + grants.
- `apps/ui/app/api/desktop/agents/[agentId]/tools/route.test.ts` — GET states, master-off hiding + 400 on nested enable, per-grant opt-in, config preservation.
- `apps/ui/components/desktop/DesktopCoworkerTools.test.tsx` — self card presentation, nested toggle PATCH, master-off collapse into the disclosure.

## Remaining unsupported self-improvement abilities (not in this slice)

- Tool installation (`tool_install`) and MCP registration/login/sign-in/status (`mcp_register`, `mcp_login`, `mcp_login_complete`, `mcp_status`, `request_mcp_sign_in`): unavailable in the desktop runtime on purpose (package execution and credential flows stay out).
- Auto-memory curation: not a tool here; remains the separate **Learn from replies** saved preference.
- Hosted `allowSoulEdit` / `allowToolInstall` switches are not surfaced in the Mac Tools settings; desktop uses its own `selfInstruction` / `verbositySet` grants under the shared master.
