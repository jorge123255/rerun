# UP-02 / TL04 team reads handoff

Source delivery only. This is not Mac acceptance and not a PASS.

The tip of this branch is the docs commit that adds this file. This file records the implementation commit and does not name that docs commit.

| SHA | Role |
| --- | --- |
| `8297fe6404caa114dcb0c2cd6006291a8abb2038` | Base. Frozen pub `desktop/finish-cloud-base-20261106-8297fe64`. Parent of the implementation. |
| `3a729be55ad35f43b63b5ceac181bc2981bf5ffb` | Implementation. `feat(desktop): keep coworker team reads off without a separate grant`. |
| `2a57fa6dd53311f763bfc9abde85997b7f7e5309` | Original pin `upstream-review-20261106`. The five `team_*` tools are not in this pin. |
| `ab3def9bfcf545cc9548f99c63c2b011ca094023` | Supplement pin `upstream-pr38-review-20261106`. |
| `2d1bdc2076136f78e84575083988931e6fcc9f02` | Supplement commit that added the five tools (`feat(tools): coworkers can read the rest of their team, read-only (#36)`). |

Cloud integration `bc-714cd9be-c9ad-5527-b2ed-6e79b2a13a08` was not used and was not rebased onto.

## What this is

Coworker team reads stay off unless the current principal's own config has `tools.desktopToolGrants.teamRead === true`. The grant id is `teamRead`. It is not hosted `tools.team` (that switch defaults on in the supplement and is not a Mac grant). It is not `callAgent`, `scheduleManage`, `trigger`, or external `mcp:read`.

`get_team_status` on the external MCP listener is a different caller. It is unchanged and does not grant these five tools.

The five model tools are `team_status`, `team_list_schedules`, `team_list_triggers`, `team_list_runs`, and `team_get_run`. Descriptions, the permission label `See other coworkers`, the blurb, the help sentence, the display labels, and the three hosted activity lines are copied from the supplement. Schedules and triggers have no activity line there, so none was invented.

Reads are refused until root binds a workspace directory plus the saved-run ports. An unbound package mounts nothing. A missing, false, stringly, stale, or other principal's flag throws `Reading other coworkers is switched off for this coworker.` and does not read. Another workspace is `That coworker is not in this workspace.`, not an empty success. A lost or thrown read throws `That coworker read is unavailable. It was not retried.` and is not called again. A stopped run throws `This run can no longer read other coworkers.` Saved-run inspection does not start a run, fire a trigger, or run a schedule.

## Original paths (read only)

- `apps/engine/src/tools/builtin/team.ts` at `2d1bdc2076136f78e84575083988931e6fcc9f02`
- `apps/ui/app/api/_services/team-hub.service.ts` (grant sentence and trigger URL strip)
- `apps/ui/components/agent/AgentPanelTools.tsx` team row
- `packages/contracts/src/agent.ts` hosted `team: z.boolean().default(true)`
- `packages/contracts/src/chat-tool-display.ts` labels and activity
- `apps/ui/lib/tool-meta.ts` icons
- `apps/ui/lib/board/team-status.ts` status order and waiting set
- `apps/ui/lib/mcp/run-projection.ts` and `apps/ui/lib/mcp/truncate.ts` (2,000-character marker)
- `apps/ui/app/api/_services/team-status.service.ts`
- `apps/ui/app/api/_services/mcp-account.service.ts` `list_schedules`, `list_triggers`, `list_runs`, `get_run`

Hosted account dispatch and `dispatchTeamHubTool` are not called. The external listener is not required.

## Changed paths (this package only)

- `packages/contracts/src/desktop-team-reads.ts` (not added to the barrel)
- `apps/engine/src/desktop/team-reads/**`
- `apps/ui/lib/desktop/team-reads/**`
- `docs/desktop-finish-team-reads-up02-handoff.md` (this file, docs commit)

Not edited: `DesktopApp`, `DesktopConversation`, composer roots, `apps/engine/src/tools/registry.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/desktop-tool-grants.ts`, `apps/ui/lib/desktop/coworker-tools.ts`, `DesktopCoworkerTools.tsx`, external MCP catalog/operations, foreman prompt, migration ladder, packaging identity, RD38 historical cards.

## Behavior and limits

- Grant check reads the caller config file raw. `agentConfigSchema` drops unknown keys, so `desktopRerunGrantsOf` cannot see `teamRead` until root adds the enum. Only boolean `true` counts. A symlink or hard link of `config.json` is off. A thrown or unreadable file is off. One read.
- Run admission reads the caller's saved run once. It must be `running` and match `agentId` and `sessionId`. Missing or finished refuses. A thrown read is uncertain and is not repeated.
- Workspace comes from the injected directory, not from listing `agents/` on disk. `team_status` without an id lists only `members(caller.workspaceId)`. A bad id does not.
- Target tools accept the public id `team_status` returns, or that member's engine id, only inside the caller workspace.
- Schedules project name, instruction, cron or date, timezone, enabled, last run. `connectionId`, provider, and model are omitted. A symlinked schedules directory is not followed.
- Triggers project name, instruction, methods, enabled, fire count, last fire. `token` and `url` are removed, including when copied into the instruction. Definitions are not fired, rotated, or replaced.
- Runs default to 20 and clamp to 1..200. `done` stays `done`. The tool description is the honesty line: done only means no technical error.
- `team_get_run` reads the saved row and saved assistant text. `includeToolCalls` must be boolean `true`. Input and result are cut at 2,000 characters with the hosted marker. Bearer values and `token`/`url`/`secret`/`password`/`apiKey` fields are omitted. The description states that tool results can carry connected-app data.
- A payload over 200,000 characters is refused with the hosted too-large sentence. It is not trimmed into a fake complete answer.
- Status order matches hosted team status: switched off, unconfigured, offline, working, waiting on a person, last finished error, idle. Waiting reasons are only `waiting_human`, `awaiting_question`, `awaiting_approval`, `awaiting_connector`, and `awaiting_ack`.
- Explicit `reachable: false` or an unconfigured member does not invent an idle team and does not read activity.
- There is no write, no retry of an uncertain read, and no second permission authority.

## Already implemented, new, and gated

| Piece | Class |
| --- | --- |
| External `get_team_status` under `mcp:read` | Already on this base. Left in place. Not this grant. |
| Local schedule files, desktop trigger definitions, run rows, tool-call rows, assistant text, session rows | Already on this base. Used only behind injected ports. Not mounted. |
| Hosted `tools.team` default-on flag | Supplement only. Not used. |
| `teamRead` contract, five tools, projections, label fragment, unrun regressions | New in `3a729be55ad35f43b63b5ceac181bc2981bf5ffb`. |
| Enum id, barrel export, catalog row, display labels, icons, registry assignment, process bind, workspace directory | Gated on root. This package does not edit those files. |

## Root fragments

Do not mount these in this branch. After the enum exists, a normal config parse keeps `teamRead`. Until then, only the raw reader sees a hand-written `true`, and a Tools save that goes through `desktopRerunGrantsSchema` strips it. That strip is what keeps the switch default-off.

Barrel, one line in `packages/contracts/src/index.ts`:

```ts
export * from './desktop-team-reads.js'
```

Grant enum, add the id. Do not default it to true:

```ts
// packages/contracts/src/desktop-tool-grants.ts desktopRerunGrantIds
'teamRead'
```

Catalog row. `available: true` only means the switch can be shown. The grant is on only when the stored value is exactly `true`:

```ts
supported('teamRead', 'See other coworkers', 'Read their routines and runs', 'team_status', 'team_list_schedules', 'team_list_triggers', 'team_list_runs', 'team_get_run')
```

The longer help is `DESKTOP_TEAM_READ_PERMISSION.help` from `packages/contracts/src/desktop-team-reads.ts`. `DesktopCoworkerTools` currently shows the catalog description, which is the blurb. Do not borrow the Call coworkers, Manage routines, or Triggers rows.

Display maps, merged by root into the existing objects, not a second map:

```ts
import { DESKTOP_TEAM_READ_ACTIVITY, DESKTOP_TEAM_READ_ICONS, DESKTOP_TEAM_READ_LABELS, DESKTOP_TEAM_READ_PROMPT } from './desktop-team-reads.js'
// chat-tool-display labels
Object.assign(labels, DESKTOP_TEAM_READ_LABELS)
// chat-tool-display activity. No schedule or trigger line is in the hosted map.
Object.assign(activity, DESKTOP_TEAM_READ_ACTIVITY)
// tool-meta: ActivityIcon, CalendarIcon, WebhookIcon, HistoryIcon, HistoryIcon
// names are DESKTOP_TEAM_READ_ICONS
```

Append `DESKTOP_TEAM_READ_PROMPT` from the tool instruction only when this caller's `teamRead` grant is on. Do not append it for `callAgent`, `scheduleManage`, `trigger`, or `mcp:read`.

Registry, inside the desktop branch of `buildTools`, after the `callAgent` assignment and before setup tools. Do not replace the loop and do not gate this on `hasDesktopToolGrant(ctx.agent.config, 'callAgent')`:

```ts
import { readDesktopTeamReads } from '../desktop/team-reads/binding.js'

const teamReads = readDesktopTeamReads()
if (teamReads && !ctx.agent.config.ephemeral) Object.assign(tools, teamReads.tools(ctx))
```

Bind once at desktop startup. This does not open a second database, mint a token, or start a listener. `desktopTeamReadPorts()` does not read until a tool call reaches it:

```ts
import { bindDesktopTeamReads, desktopTeamReadPorts, readDesktopTeamAdmit, readDesktopTeamReadGrantFromDisk } from '../desktop/team-reads/index.js'
import { DESKTOP_TEAM_DIRECTORY_CALLER_SQL, DESKTOP_TEAM_DIRECTORY_LOOKUP_SQL, DESKTOP_TEAM_DIRECTORY_MEMBER_SQL } from './desktop-team-reads.js'

bindDesktopTeamReads({
    grant: readDesktopTeamReadGrantFromDisk,
    admit: readDesktopTeamAdmit,
    reads: desktopTeamReadPorts(),
    directory: desktopTeamDirectory,
})
```

`desktopTeamDirectory` is root-owned. It reads the existing `desktop_agents` table. SQL is the three constants above.

- Caller: `DESKTOP_TEAM_DIRECTORY_CALLER_SQL` with the engine agent id. Zero rows means the workspace is not bound. Return `{ workspaceId: String(workspace_id), publicId: id, engineAgentId }`.
- Members: `DESKTOP_TEAM_DIRECTORY_MEMBER_SQL` with that same `workspace_id` only.
- Lookup: `DESKTOP_TEAM_DIRECTORY_LOOKUP_SQL` with the requested id twice. Zero rows is `missing`. More than one row is `uncertain`. A row whose `workspace_id` differs is `other-workspace` and its name, handle, and engine id are not returned. The same workspace returns `member`.

Map `enabled` from `desktop_agents.enabled`, `deleting` from `desktop_deletions`, `spaceId` from `desktop_space_placements.space_id`, and `handle` from `desktop_rename_checks.handle` or null. Do not copy the display name into the handle. `configured` is true only when `engine_agent_id` is present. Set `reachable: false` only when the machine is already known to be down. Otherwise omit `reachable` so activity is read.

Do not implement this directory by calling `listAgentIdsOnDisk`.

## Authored unrun regressions

Not executed in this lane.

- `apps/engine/src/desktop/team-reads/team-reads.test.ts`
- `apps/ui/lib/desktop/team-reads/labels.test.ts`

| Case | Expectation |
| --- | --- |
| `tools.team`, `callAgent`, `scheduleManage`, `trigger`, string `teamRead`, `mcp:read` | Grant stays off. |
| Exact `teamRead: true` | Raw reader accepts it, once. |
| Symlink or hard link of the config file | Off, and the file body is not read. |
| Grant off or stale at execute time | Switched-off sentence. Schedule and member ports are not called. |
| Other engine id | Workspace-unbound sentence. Members are not listed. |
| Other workspace | Other-workspace sentence. Trigger port is not called. |
| `../` id or missing `agentId` | Malformed sentence. No team dump and no grant read. |
| Port returns `uncertain` or throws | Unavailable sentence. That port is called once. |
| Aborted run | Run-closed sentence. Grant is not read. |
| Admit refused or uncertain | No run listing and no run fetch. Admit is not repeated. |
| `team_status` | Public id, workspace id `1` in the fake, activity read uses the engine id. |
| Run limit omitted / 999 | 20 / 200. |
| Trigger payload | No token and no `https` URL. |
| `includeToolCalls` omitted or false | Tool-call port is not called. `done` stays `done`. |
| `includeToolCalls: true` | Cut at 2,000. Bearer value omitted. Port called once. No start spy. |
| Unconfigured or `reachable: false` | `unconfigured` / `offline`. Activity is not read. |
| Disabled member | `switched_off`, even when a run is in flight. |
| Oversized schedule body | Too-large sentence. Port called once. |
| Symlinked schedule directory | Uncertain. List is not called. |
| Thrown trigger list or run list | Uncertain. Called once. |
| Admit of a finished run, or no run id | Refused. A thrown get is uncertain and is not repeated. |
| Run row for a different agent | Null detail. Output is not read. |
| Label row | `teamRead`, `See other coworkers`, `defaultEnabled: false`, no `get_team_status`. |

## Checks not run

Tests, typecheck, lint, build, install, formatters, fixtures, provider calls, network, UI, browser, native, database, Keychain, listeners, accounts, permission prompts, restart, guest, Docker, and microphone were not run.

No push, pull request, merge, rebase, or cherry-pick.

## Hook stop

None. The implementation commit was created with the sample hooks only. `core.hooksPath` was empty. `--no-verify` was not used.

## Risks

- Until root adds `teamRead` to `desktopRerunGrantIds`, a Tools save that parses `agentConfigSchema` removes the flag. The package will keep refusing. That is the default-off behavior, not a mounted switch.
- Root must supply the directory from `desktop_agents`. Binding `desktopTeamReadPorts()` without that directory throws `Desktop team read authority is required`.
- Desktop session rows often stay `open`, so `waitingOn` is empty unless a session status is one of the five hosted waiting values. That is not a claim that nobody is waiting.
- Handles are null when `desktop_rename_checks` has no row. The display name is not used as a handle.
- A regular copied config file with `teamRead: true` still grants. Duplicate-grant policy is left to root. This package only refuses a symlink or hard link of the config file.
- Schedule reads lstat the directory and then call `listSchedules`. A directory replaced by a symlink between those two steps can still be followed. Trigger definition reads recheck links themselves.
- `readDesktopTeamAdmit` and the production ports open the coworker's existing system database when a tool call reaches them. Importing the package does not. Tests inject fakes and do not open it.
- Tool-call text can still contain connected-app data below the 2,000-character cut. The tool description says so. Field names `token`, `url`, `secret`, `password`, `authorization`, `apiKey`, and `webhook` are dropped. Other secret shapes are not detected.
- Response ceiling refuses the whole payload. It does not page it.

## Unsupported

- Live hub or account dispatch, hosted Supabase team status, and the external MCP listener.
- Turning the tools on by default, or by any grant other than `teamRead`.
- Returning webhook URLs, tokens, or API keys.
- Starting, continuing, or retrying a run. Firing, rotating, or editing a trigger. Running a schedule.
- A team dashboard, polling, or a live Connected badge.
- Historical MCP connect and hosted brain undo. Those stay in their own lanes.
- Editing the central registry, grant enum, barrels, or coworker Tools screen in this branch.
