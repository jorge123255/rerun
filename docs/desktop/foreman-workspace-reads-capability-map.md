# Foreman workspace reads — capability map

Upstream pin: `rerun-build/rerun` `c33c020ffb33263ec29de6f76d9b269bca786d90`.
Mac pin: `7080add37a60bd604965649319143b8211818fd9` (tree `e7db3a3f5df8057ffe86576153a8acff3360481b`).

This map traces every tool declared for the Foreman belt in upstream `apps/ui/lib/foreman/tool-defs.ts`, wired by `foremanTools` (`apps/ui/lib/foreman/tools.ts:35`) and `dispatchBoxTool` (`apps/ui/lib/foreman/box-tools.ts:9`). The workspace half is briefed by `foremanEngineBrief` (`apps/ui/lib/foreman/engine-brief.ts:34`), instantiated in the engine by `hubTool` (`apps/engine/src/tools/builtin/foreman.ts:31`), and executed on the hub by `dispatchForemanHubTool` (`apps/ui/app/api/_services/foreman-hub.service.ts:18`). That gate refuses any name outside `FOREMAN_ENGINE_HUB_TOOL_NAMES`, then calls `dispatchAccountTool(actor, …)` (`apps/ui/app/api/_services/mcp-account.service.ts:313`). The actor is the member behind the turn, or the workspace founder when the turn has no member. Box listing and coworker listing are not a raw workspace dump: `list_spaces` keeps rows `spaceAccessMap` marks visible (`apps/ui/app/api/_auth/access.ts:145`), and `list_agents` / `get_team_status` pass through `keepVisible` (`apps/ui/app/api/_auth/access.ts:187`). Agent-scoped reads call `resolveAgentTarget` (`apps/ui/app/api/_services/chat.service.ts:28`).

The Mac desktop Foreman does not take that hub belt. `desktopForemanTools` (`apps/engine/src/desktop/foreman/binding.ts:32`) returns its own set. Hosted `dispatchAccountTool` remains on the non-desktop path and is not the Mac authority.

Offline-read column values: `yes`, `needs new grant`, `needs remote service`, `needs product decision`, `mutation, out of scope`.

## Summary

| Group | Upstream tool | Def at c33c020 | Dispatch at c33c020 | Mac equivalent at 7080add3 | Authority | Offline read | This bundle |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Boxes | `list_spaces` | `ACCOUNT_TOOL_DEFS` via `accountToolDef` `tool-defs.ts:567`; name `account-tools.ts:61`; belt `FOREMAN_MCP_TOOL_NAMES` `tool-defs.ts:16` | `dispatchAccountTool` case `mcp-account.service.ts:319` | `readDesktopBoardState` `apps/ui/lib/desktop/server/spaces.ts:101` | Desktop runtime workspace owns the catalog file. Hosted `spaceAccessMap` has no Mac twin. | yes | Mounted |
| Roster | `list_agents` | `account-tools.ts:66`; belt `tool-defs.ts:17` | `mcp-account.service.ts:333` | `listDesktopAgents` `apps/ui/lib/desktop/server/store.ts:114` and `desktopTeamDirectory` `apps/engine/src/desktop/team-reads/directory.ts:31` | Same runtime workspace. In-file rows stay on catalog id `1`. | yes | Mounted |
| Roster | `get_team_status` | `account-tools.ts:74`; belt `tool-defs.ts:18` | `mcp-account.service.ts:338` → `readTeamStatus` `team-status.service.ts:28` | `team_status` `apps/engine/src/desktop/team-reads/tools.ts:140` | `desktopToolGrants.teamRead` on a coworker, not on Foreman | needs product decision | Not mounted |
| Roster | `get_agent` | `account-tools.ts:86`; belt `tool-defs.ts:19` | `mcp-account.service.ts:343` | none as a Foreman read. `findDesktopAgent` exists and returns a wider row. | Would expose soul, tool flags, and model identity | needs product decision | Not mounted |
| Roster | `create_agent` | `account-tools.ts:96` | `mcp-account.service.ts:394` | Desktop creation flow, user-confirmed | Foreman must not create coworkers | mutation, out of scope | Not mounted |
| Roster | `update_agent` | `account-tools.ts:121` | `mcp-account.service.ts:433` | Rename / move on the board | | mutation, out of scope | Not mounted |
| Roster | `delete_agent` | `account-tools.ts:166` | `mcp-account.service.ts:509` | Coworker delete | | mutation, out of scope | Not mounted |
| Roster | `list_ai_connections` | `account-tools.ts:147` | `mcp-account.service.ts:483` | Settings provider list | Account emails and provider identity | needs product decision | Not mounted |
| Roster | `set_default_model` | `account-tools.ts:153` | `mcp-account.service.ts:498` | Settings default model | | mutation, out of scope | Not mounted |
| Skills | `list_skills` | `account-tools.ts:176` | `mcp-account.service.ts:519` | `listCoworkerSkills` `coworker-skills.ts:120`; coworker `skill_list` `skill-tools.ts:127` under `skills` | `skills` is that coworker's own grant and also allows writes. Not a Foreman grant to read someone else. | needs new grant | Not mounted |
| Skills | `get_skill` | `account-tools.ts:186` | `mcp-account.service.ts:537` | `getCoworkerSkill` `coworker-skills.ts:124` | same | needs new grant | Not mounted |
| Skills | `read_skill_file` | `account-tools.ts:196` | `mcp-account.service.ts:548` | `readCoworkerSkillFile` `coworker-skills.ts:223` | same | needs new grant | Not mounted |
| Skills | `upsert_skill` | `account-tools.ts:211` | `mcp-account.service.ts:559` | skill write tools | | mutation, out of scope | Not mounted |
| Skills | `delete_skill` | `account-tools.ts:274` | `mcp-account.service.ts:634` | skill delete | | mutation, out of scope | Not mounted |
| Routines | `list_schedules` | `account-tools.ts:284`; belt `tool-defs.ts:29` | `mcp-account.service.ts:644` | `readDesktopTeamSchedules` `team-reads/adapters.ts:59` and `desktopTeamScheduleView` `project.ts:88`. Coworker `schedule_list` `schedule-tools/tools.ts:63` under `scheduleManage`. | Workspace ownership for metadata. `scheduleManage` is the coworker's own manage grant and is not reused. `teamRead` stays on coworker `team_list_schedules` only. | yes | Mounted |
| Routines | `upsert_schedule` | `account-tools.ts:294` | `mcp-account.service.ts:650` | schedule manage tools | | mutation, out of scope | Not mounted |
| Routines | `run_schedule_now` | `account-tools.ts:315` | `mcp-account.service.ts:689` | schedule run | | mutation, out of scope | Not mounted |
| Routines | `delete_schedule` | `account-tools.ts:325` | `mcp-account.service.ts:694` | schedule delete | | mutation, out of scope | Not mounted |
| Triggers | `list_triggers` | `account-tools.ts:335`; belt `tool-defs.ts:41` | `mcp-account.service.ts:702` via `projectTrigger` `mcp-account.service.ts:227` (includes webhook URL) | `readDesktopTeamTriggers` `adapters.ts:87` and `desktopTeamTriggerView` `project.ts:112` (drops `token` and `url`). Coworker `trigger_list` `trigger-tools/tools.ts:117` under `trigger`. | Same workspace ownership. The `trigger` grant is manage-and-fire, not a Foreman read. URL and token are not returned. | yes | Mounted |
| Triggers | `upsert_trigger` | `account-tools.ts:345` | `mcp-account.service.ts:709` | trigger manage | | mutation, out of scope | Not mounted |
| Triggers | `test_trigger` | `account-tools.ts:368` | `mcp-account.service.ts:741` | trigger fire | | mutation, out of scope | Not mounted |
| Triggers | `rotate_trigger_token` | `account-tools.ts:385` | `mcp-account.service.ts:774` | token rotate | Credential | mutation, out of scope | Not mounted |
| Triggers | `delete_trigger` | `account-tools.ts:394` | `mcp-account.service.ts:781` | trigger delete | | mutation, out of scope | Not mounted |
| Runs | `send_message` | `account-tools.ts:404` | `mcp-account.service.ts:789` | Desktop chat send | | mutation, out of scope | Not mounted |
| Runs | `list_runs` | `account-tools.ts:419` | `mcp-account.service.ts:816` | `team_list_runs` under `teamRead` | Run rows can carry connector data. Already a coworker grant, not widened onto Foreman. | needs product decision | Not mounted |
| Runs | `get_run` | `account-tools.ts:428` | `mcp-account.service.ts:822` | `team_get_run` under `teamRead` | Output is transcript-like. | needs product decision | Not mounted |
| Data | `list_tables` | `account-tools.ts:438` | `mcp-account.service.ts:849` | `db_schema` inside `desktopDbTools` `data-tools.ts:107` | `db` also mounts `db_execute`. No read-only schema grant for Foreman. | needs new grant | Not mounted |
| Data | `db_query` | `account-tools.ts:448` | `mcp-account.service.ts:854` | `db_query` under `db` | same, and it returns row contents | needs new grant | Not mounted |
| Data | `db_execute` | `account-tools.ts:462` | `mcp-account.service.ts:863` | `db_execute` | | mutation, out of scope | Not mounted |
| Data | `list_space_tables` | `account-tools.ts:482` | `mcp-account.service.ts:871` | `shared_db_schema` under `sharedDb` | `sharedDb` includes writes | needs new grant | Not mounted |
| Data | `space_db_query` | `account-tools.ts:492` | `mcp-account.service.ts:876` | `shared_db_query` | | needs new grant | Not mounted |
| Data | `space_db_execute` | `account-tools.ts:506` | `mcp-account.service.ts:885` | `shared_db_execute` | | mutation, out of scope | Not mounted |
| Connectors | `search_connectors` | `account-tools.ts:526` | `mcp-account.service.ts:893` | Service catalog | Lane G owns the MCP broker. Catalog search is not mounted here. | needs product decision | Not mounted |
| Connectors | `list_connectors` | `account-tools.ts:538` | `mcp-account.service.ts:898` | Installed-service list | May reveal linked accounts | needs product decision | Not mounted |
| Connectors | `list_agent_connectors` | `account-tools.ts:550` | `mcp-account.service.ts:916` | none on Foreman | same | needs product decision | Not mounted |
| Connectors | `attach_connector` | `account-tools.ts:560` | `mcp-account.service.ts:922` | service install | | mutation, out of scope | Not mounted |
| Connectors | `detach_connector` | `account-tools.ts:574` | `mcp-account.service.ts:954` | service detach | | mutation, out of scope | Not mounted |
| Shares | `plan_agent_share` | `share-tools.ts:11` | `mcp-shares.service.ts:42` | Desktop share flows | Public sharing is out of scope | needs product decision | Not mounted |
| Shares | `create_agent_share` | `share-tools.ts:21` | `mcp-shares.service.ts:57` | | | mutation, out of scope | Not mounted |
| Shares | `list_agent_shares` | `share-tools.ts:43` | `mcp-shares.service.ts:79` | | Share URLs | needs product decision | Not mounted |
| Shares | `revoke_agent_share` | `share-tools.ts:49` | `mcp-shares.service.ts:96` | | | mutation, out of scope | Not mounted |
| Boxes | `create_boxes` | `FOREMAN_BOX_TOOL_DEFS` `tool-defs.ts:63` | `dispatchBoxTool` `box-tools.ts:12` | Board create | | mutation, out of scope | Not mounted |
| Boxes | `rename_box` | `tool-defs.ts:75` | `box-tools.ts:27` | Board rename | | mutation, out of scope | Not mounted |
| Boxes | `delete_box` | `tool-defs.ts:84` | `box-tools.ts:31` | Board delete | | mutation, out of scope | Not mounted |
| Docs | `search_docs` | `FOREMAN_DOCS_TOOL_DEFS` `tool-defs.ts:100` | `foreman-hub.service.ts:22` → `searchForemanDocs` | `search_docs` in `desktopForemanDocsTools` `foreman-docs/tools.ts:22` | Already mounted, public corpus only | yes | Already mounted |
| Onboarding | `analyze_website` | `tool-defs.ts:276` | `onboarding-tools.ts:136` | `read_company` `foreman/tools.ts:37` | Already mounted, public pages, bounded | yes | Already mounted |
| Onboarding | `save_profile` | `tool-defs.ts:286` | `onboarding-tools.ts:153` | Intake save (lane A) | | mutation, out of scope | Not mounted |
| Onboarding | `list_templates` | `tool-defs.ts:312` | `onboarding-tools.ts:138` and `mcp-templates.service.ts:100` | Local template list | Marketplace and local template policy | needs product decision | Not mounted |
| Onboarding | `install_template` | `tool-defs.ts:324` | `onboarding-tools.ts:140` | Template install | | mutation, out of scope | Not mounted |
| Onboarding | `install_shared_agent` | `tool-defs.ts:334` | `onboarding-tools.ts:142` | | Hosted share install | needs remote service | Not mounted |
| Onboarding | `start_agent_setup` | `tool-defs.ts:344` | `onboarding-tools.ts:144` | Setup start is a user click. `FOREMAN_FORBIDDEN_TOOL_NAMES` includes it. | | mutation, out of scope | Not mounted |
| Widgets | `show_plan` | `showPlanDef` `tool-defs.ts:216` | Client widget, no hub execute (`tools.ts:67`) | `show_plan` `foreman/tools.ts:24` | Already mounted. Does not build the team. | yes | Already mounted |
| Widgets | `show_templates` | `showTemplatesDef` `tool-defs.ts:236` | Client widget | none | Template cards | needs product decision | Not mounted |
| Widgets | `ask_choice` | `tool-defs.ts:376` | Client widget | `ask_user` | Already a separate question tool | needs product decision | Not mounted |
| Widgets | `ask_either` | `tool-defs.ts:390` | Client widget | none | | needs product decision | Not mounted |
| Widgets | `open_checkout` | `tool-defs.ts:404` | Client widget | none | Billing | needs remote service | Not mounted |
| Widgets | `open_template_purchase` | `tool-defs.ts:410` | Client widget | none | Billing | needs remote service | Not mounted |
| Widgets | `ask_input` | `tool-defs.ts:415` | Client widget | `ask_user` | | needs product decision | Not mounted |
| Widgets | `contact_team` | `tool-defs.ts:425` | Client widget | none | Support channel | needs remote service | Not mounted |
| Widgets | `show_starter_pack` | `tool-defs.ts:443` | Client widget | Intake / starter (lane A) | | needs product decision | Not mounted |
| Client | `focus_agent` | `tool-defs.ts:463` | Intent, `intentTool` `foreman.ts:42` | `open_panel` is a different, already-mounted navigation tool | UI intent | needs product decision | Not mounted |
| Client | `show_agents` | `tool-defs.ts:481` | Intent | none | | needs product decision | Not mounted |
| Client | `open_settings` | `tool-defs.ts:506` | Intent | none | | needs product decision | Not mounted |
| Client | `open_connector_setup` | `tool-defs.ts:517` | Intent | none | | needs product decision | Not mounted |
| Client | `open_template_card` | `tool-defs.ts:530` | Intent | none | | needs product decision | Not mounted |
| Client | `recenter_board` | `tool-defs.ts:540` | Intent | none | | needs product decision | Not mounted |
| Client | `open_brain_page` | `tool-defs.ts:546` | Intent | Coworker `brain` grant, not Foreman | | needs product decision | Not mounted |
| Files | (not a belt name) hosted `upload_workspace_file` is on `ACCOUNT_TOOL_DEFS` and is **not** in `FOREMAN_MCP_TOOL_NAMES` | | | `agent_files_read` / `agent_files_list` / `agent_files_search` under `foremanAgentFilesRead` `foreman-agent-files/tools.ts:68`. Default off. Coworker `fs_read` under `workspaceRead`, also default off. | Existing file grants already mounted for their own tools. This bundle does not add another file read and does not turn those grants on. | yes, already granted separately | Not mounted here |

`write_memory` (`account-tools.ts:237`) is on the account catalog and is not on `FOREMAN_MCP_TOOL_NAMES`. It is not a Foreman belt tool.

## Available through a gated adapter

Four read-only tool definitions. If an explicitly authorized production adapter is bound through `bindForemanWorkspaceReads`, they are merged inside `desktopForemanTools` before `registerDesktopForemanTools` only when that call's grant check returns true. Names: `list_spaces`, `list_agents`, `list_schedules`, `list_triggers`. A grant that is false hides them. A grant that flips to false after they are on the belt is refused again inside each execute.

Authority, re-checked on every call:

- `foremanWorkspaceReadRuntimeMatches` checks runtime identity only. It does not authorize access. An independent, explicit workspace-read grant is required before mounting the adapter. The function re-reads the desktop runtime. The binding workspace id must match `runtime.workspaceId` on both reads, with the same launch nonce. A missing runtime, a mismatch, or a nonce change is a refusal.
- `readForemanWorkspaceSnapshot` calls `readDesktopBoardState` and `listDesktopAgents` (no second SQL). A revision change between those reads is `uncertain` and is not served.
- Roster membership for routines is `desktopTeamDirectory` queried with the in-file catalog id (`1`), never with a model-supplied path. Schedule and trigger bodies go through `desktopTeamScheduleView` and `desktopTeamTriggerView`.
- The tool refuses when the caller pins a board `revision` that is not the one just read. It also refuses when the two snapshots in the call disagree.
- Result cap is 50 rows. Text is scrubbed for bearer tokens, secret query params, and absolute paths. Engine ids, webhook URLs, tokens, and file paths are not fields on the result.

`teamRead`, `foremanAgentFilesRead`, `foremanAgentFilesWrite`, `skills`, `db`, `sharedDb`, `scheduleManage`, and `trigger` are unchanged. Delegation is still spread after the Foreman registry. File grants stay default off.

## Tested-design boundaries (not mounted)

- Skills and skill files. The `skills` grant is the coworker's own grant and includes writes. There is no Foreman grant that means "read this other coworker's skills."
- Private and shared database schema and queries. `db` and `sharedDb` include execute. There is no read-only data grant to put on Foreman.
- Further file reads. `foremanAgentFilesRead` already covers another coworker's visible text files and stays off until that grant is exactly true.
- Live team status, full coworker identity, and run transcripts. Those are either wider than metadata or already behind `teamRead` for coworkers. Putting them on Foreman would widen that grant.
- Hosted box visibility (`spaceAccessMap`). The Mac catalog is the runtime workspace's file, not a multi-member ACL.
- Connector, share, template, checkout, and account-connection reads. They need the MCP broker, a remote service, or a product decision.
- Every mutation on the belt, including box create/rename/delete.
