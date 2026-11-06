# Round36 C — external MCP catalog: dependency checkpoint

Branch `desktop/round36-external-mcp-tools`; verified initial HEAD `970415507e28824bb001f46c8537d20fd2636b1c` and clean status. This is a committed source inventory, **not an implemented dispatcher or W4 completion**. No tests, typecheck, lint, builds, installs, servers, network/provider calls, Docker, UI, Keychain, live databases or restart checks were executed. No push/merge/activation.

## Blocking published contract

Assignment step 2 says: “Consume B’s exact published principal/grant contract. If not yet published, complete the source inventory and await that schema; do not invent another external key or principal format.”

Read-only inspection of `round36-external-mcp-authority` found HEAD `970415507e28824bb001f46c8537d20fd2636b1c`, empty short status and no external-MCP/principal contract or Round36 B handoff. No such contract exists in this prepared lane either. Therefore no principal, grant ID, receipt protocol, key format, authorization callback or dispatch registration has been invented. B’s published contract revision: **not available at this checkpoint**.

Required publication: exact canonical file/commit and exports for authenticated principal/workspace/lifetime identity; operation scopes; live revoke checks and cancellation/drain; tool registration/call context; stable request ID and receipt custody. Once published, resume implementation against that source. Do not use `unknown`/casts or ambient internal auth to bypass the dependency. No one is being asked to repair this checkpoint; it is an explicit prerequisite.

## Original source inventory and local candidates

Inspected pinned original `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/lib/mcp/account-tools.ts`: actual schemas/descriptions/order, 37 agent/domain definitions plus imported sharing/templates.
- `apps/ui/lib/mcp/{share-tools,template-tools}.ts`: 4 share and 12 template definitions.
- `apps/ui/app/api/_services/mcp-account.service.ts`: owned agent resolution, model/setup validation, skill locks, trigger projection, run polling/results, SQL domain routing, connector instances.
- `apps/ui/app/api/mcp/account/route.ts`: Bearer account key, tools/list, tools/call, bounded-result refusal, text and structuredContent result envelope, isError for tool errors. Notifications 202; protocol versions 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07. Original account authentication is hosted and must not become desktop authority.

The new inventory imports existing pure `ACCOUNT_TOOL_DEFS`, retaining exact descriptions/input schemas/order by reference. It is deliberately **not** a tools/list response, dispatcher or executable registration. `implemented:false` is explicit for every row. Observational candidates are classified separately from effects; a SELECT tool still requires authoritative read-only SQL enforcement rather than regex checking.

| Family | Original tools / response expectations | Existing local source to adapt after B publication | Current external implementation |
| --- | --- | --- | --- |
| Agents/Boxes | list_spaces → spaces; list_agents → agents; get_team_status; get_agent; create_agent/update_agent/delete_agent | `server/store.ts`: listDesktopAgents/findDesktopAgent/readDesktopBootstrap; current authenticated coworker routes and roster/setup gates. Engine detail is not a public DTO. | Missing; B-dependent |
| Model configuration | list_ai_connections; set_default_model | Existing local provider/model custody and public connection projection; never return tokens or internal engine keys. | Missing; B-dependent |
| Skills | list_skills → skills; get_skill; read_skill_file → slug plus reference page; upsert_skill/delete_skill | `server/coworker-skills.ts`: listCoworkerSkills/getCoworkerSkill/readCoworkerSkillFile, service ownership and proposal/review authorities. Do not invoke writes to implement a read. | Missing; B-dependent |
| Routines | list_schedules → schedules; upsert_schedule/run_schedule_now/delete_schedule | `server/schedules-binding.ts`: desktopScheduleRequest/authorizeDesktopSchedules; `server/schedule-tools/runtime.ts`; engine schedule-tools revision/lifecycle. Listing must not run/reconcile schedules. | Missing; B-dependent |
| Triggers | list_triggers → triggers; upsert_trigger/test_trigger/rotate_trigger_token/delete_trigger | `server/triggers/{api,binding,engine}.ts` and trigger-requests lifecycle/journal. List must strip secret URL/token custody; rotation is an effect. | Missing; B-dependent |
| Runs | send_message; list_runs → runs; get_run → projected run/output plus optional bounded toolCalls | Current engine read APIs behind local owned-session/coworker resolution. send_message requires explicit effect scope, setup/enabled gates, exact model/run request identity and receipt recovery; no automatic testing run. | Missing; B-dependent |
| Private/shared tables | list_tables/list_space_tables → tables; db_query/space_db_query → query result; db_execute/space_db_execute → execution result | Current desktop data server/domain routes, engine SQL validators; renderer `lib/desktop/data-source.ts` shows actual domain contract but is not a server authorization adapter. Resolve agent/Box from principal’s owned runtime first. | Missing; B-dependent |
| Files | **No standalone file tools in the pinned account catalog.** read_skill_file is skill-scoped. | `server/coworker-files.ts`: listCoworkerFiles/readCoworkerFile; `server/shared-workspace-files.ts`: listDesktopSharedFiles/readDesktopSharedFile. Existing accepted own-file readers/identity bounds remain authoritative. | No original account tool; any additive names require root/B contract decision, not invented aliases |
| Brain | **No standalone Brain tools in the pinned account catalog.** | `server/brain-pages.ts`: desktopBrainPagesRequest; existing engine brain-pages policy/router and proposal review. Shared SQL database is not Brain. | No original account tool; additive names require root/B decision |
| Connectors | search_connectors/list_connectors/list_agent_connectors; attach_connector/detach_connector | Local catalog and service/account lifecycle only; authenticated/encrypted configuration remains local. Must return actual readiness rather than catalog verification or saved-secret flags. | Missing; B-dependent |
| Sharing | plan_agent_share/create_agent_share/list_agent_shares/revoke_agent_share | Paired Round36 sharing lane owns any local contract. Do not copy its files or call hosted sharing. | Unsupported until exact paired local authority is published |
| Templates | list_templates/get_template/create_template/update_template/submit_template/withdraw_template/delete_template/list_capture_sources/plan_template_capture/capture_template_agents/remove_template_agent/add_template_image | Existing local portable-template readers/reviews may support a subset later; publishing/submission/image upload never implied by a local key. | No external bindings; hosted operations unsupported |
| Billing/members/hosted account | No direct matching definitions in this pinned account tool list | No local replacement authority inferred. | Explicit unsupported at future dispatcher; no fabricated results |

Original confirms are not sufficient external authority: delete_agent/delete_skill/delete_schedule/delete_trigger and detach_connector retain original confirm requirements PLUS B operation scope and canonical revision/review. Original names alone cannot supply stable request/revision identity; these must use B’s exact call/receipt context or explicit additive schemas approved by root. Do not remove prior receipts and repeat effects after restart.

## Workspace/runtime inspection

Read root integration reference at `052f6f66f8f8eaca27d5ea878d2cf3024e617dc0`: canonical `packages/contracts/src/desktop-workspaces.ts` (version 1, positive numeric workspace ID), native `main/workspaces/{ports,isolation,coordinator}.mjs`, updated assignment standard, and current prepared `server/runtime.ts` boundary.

Native catalog/selection and transition receipts remain sole workspace identity authority. The reference itself identifies missing W1-A1 arbitrary-workspace start, W1-A2 admission freeze, W1-A3 runtime health identity, W1-A5 per-workspace DB binding. Prepared `DesktopRuntime` still validates `workspaceId:z.literal(1)`. An external principal selecting another workspace cannot be mapped to active workspace 1 or a directory chosen from request text. Stop/refuse if its canonical runtime binding is unavailable. No second workspace catalog or runtime file was created/read.

Future binding must resolve the principal’s workspace to a canonical live runtime lifetime; every awaited domain read/effect rechecks that identity and B’s live grant before commit/response. Shutdown/revoke drains admitted work, suppresses late output and retains uncertain receipts. Internal app sessionToken/engine apiKey stay inside existing custody; never return raw runtime objects or relay internal authentication to external clients.

## Changed paths and activation status

- `apps/ui/lib/desktop/server/external-mcp-tools/inventory.ts`: pure original definition/family/read-candidate inventory; zero external effects.
- `apps/ui/lib/desktop/server/external-mcp-tools/inventory.test.ts`: authored, unrun assertions retaining original definitions/order and distinguishing run/SQL/schedule/token mutations from reads.
- `docs/desktop-round36-c-handoff.md`: this checkpoint.

No engine adapters are claimed. No central files changed. No migration is necessary for the inventory because it stores nothing. No registration/import fragment can honestly activate it: **do not register the inventory as runnable tools.** Concrete B dispatch registration, receipts/migrations and root activation fragments remain blocked on the missing published contract, as required by task step 2. Domain authorities listed above are implementation candidates, not a claim of completed external support.

Read applicable root CLAUDE, UI AGENTS/CLAUDE and assignment standard. Installed Next documentation absent at `node_modules/next/dist/docs` and `apps/ui/node_modules/next/dist/docs`; no Next API is introduced. UI design/mounting is outside this source package.

## Remaining implementation after dependency release

Implement bounded canonical read adapters for every supported domain and scope-filtered tools/list. Add only mutations with actual operation scopes, object revisions, durable fingerprint/receipt recovery and existing human-review gates. Supply concrete registration against B’s published exports and root lifetime drain hooks. Author domain regressions for each operation family, cross-workspace denial, revoke during await, changed-request conflict, stale replacement and same-receipt recovery. Current regression source covers inventory only; no security/runtime regression passes or acceptance results are claimed.

The owned runtime task is **blocked**, not complete. W4 and installed/native/restart acceptance remain pending root.
