# Rerun Mac: full remaining-work register

> Historical checkpoint: this document records its named source/build and predates
> the fork development reconciliation. Use the [current Mac status](desktop-macos-status.md)
> for integrated source and outstanding QA. Preserve the findings and acceptance
> evidence below; they do not establish acceptance of a newer app build.

Source baseline: 6 November 2026. The seven UP packets were an incomplete account of the remaining product. They covered a recent upstream comparison and several tool omissions. The wider review below also checks older original behavior, mounted screens, provider admission, Foreman, service methods and delivered agent work.

Original: `rerun-build/rerun/dev` at `ab3def9bfcf545cc9548f99c63c2b011ca094023`, verified against GitHub during this audit. Mac coding source reviewed: `b88a4f525e9c88a2ccd945d8d0e8d31edb1d6065`. The last accepted installed runtime remains `34c9cf39a2240e2b6122e8414ebb4f9f74b61697`; this documentation audit changes no application behavior.

Coverage: all 27 original model-tool families, the additional Foreman/native/setup/dynamic-tool surfaces, 80 mounted UI surface groups, runtime/provider/service/lifecycle categories, current RD37/RD38 handoffs and the original platform/mobile authorities. The evidence maps actual mounts, grants, provider filters and execution bindings. Inherited files and authored tests alone do not establish a working feature.

The historical 35 rows (14 checked for their recorded scopes, 21 open) remain acceptance records. They are not a complete or atomic missing-feature count. Checked Files, Brain, schedules and delegation journeys have additional original-product residuals below. Preserve their accepted behavior while completing those residuals.

## Reading this register

- **Integrate:** committed source exists; root must review, repair, bind and accept it. Do not assign a duplicate implementation.
- **Port:** an original operation or design is missing or narrower in mounted Mac code.
- **Repair:** a concrete source defect or integration problem, owned by root.
- **Decide:** an intentional permission/product adaptation needs an explicit parity decision; do not silently widen access.
- **Configure / QA:** code exists, but genuine configured/native/restart acceptance is outstanding.
- **Conditional:** requires a host, identity service, compatible remote protocol, commercial service or release decision.

IDs identify concrete work scopes, not numbered rounds. An integration entry, a repair it depends on and its QA gate are stages of the same feature and must not be added as three missing products. RD38–RD45 are planning checkpoints; RD45 is not a verified finish date.

## Committed agent work awaiting root integration

| ID | State | Remaining work / closure | Original checklist |
|---|---|---|---|
| IN01 | Integrate + repair | RD37 A/B custom providers: secure canonical connection storage, durable operations/revisions, routes, catalog/default selection, model dispatch and lifecycle. Fix stale connection forms, uncertain-operation recovery, DNS/socket reuse, cancellation/busy races and the unconditional 120-second inference limit before activation. | Provider settings / E2 |
| IN02 | Integrate | RD37 C/D OpenCode Go/Console: enums, credentials, registry, model resolution, migrations, catalog/limits, Settings and actual execution/Stop/error handling. | Provider settings |
| IN03 | Integrate | RD37 E/F sourced company profiles: contracts, migration, routes, selected inference model, evidence and C35 intake/Stop/Quit binding. Preserve accepted manual intake. | E11 |
| IN04 | Integrate | RD37 G question descriptions, chips/drafts and transcript wrappers: preserve saved IDs/fingerprints and mount actual consumers; align only genuine saved transcript metadata. | C3–C6/C8 |
| IN05 | Integrate + repair | RD37 H failed-chat recovery: recorded errors/model revision, reconnect/notice/retry, first-turn no-session behavior and uncertain send reconciliation. | C2/C5/C6/C8 |
| IN06 | Integrate | RD37 I tool/card ordering, root-union schemas and tool-name repair. Compose the Codex error-info fragment into both shipped dependency formats, preserving existing Mac patch hunks and the CLI pin. This package does not include cron. | C8/E5 |
| IN07 | Integrate | RD38 A/B/E portable memories and logical private DB/view transfer: bind canonical capture/install readers and writers, migrations, archive seam, review/options UI and fresh identity. Keep options unavailable until those authorities work. | D9/W3 |
| IN08 | Integrate | RD38 C remaining Control Center labels/contextual actions and current-owner routing. Preserve existing open chats, drafts and scoped navigation. | B5 |
| IN09 | Integrate + repair | RD38 D historical tool/result/status presenters. Mount them without replaying actions; also close FX15. Presentation of a historical notification is not delivery of a new notification. | C8 |
| IN10 | Integrate + repair | RD38 F/G multiple named API-key connections: canonical routes, migrations, receipts/recovery, model snapshots and real pending-run drain/removal. Review secret-derived receipt/fingerprint data and credential-presence versus successful-probe semantics. This covers API providers, not multiple ChatGPT/Claude subscriptions. | Provider settings |
| IN11 | Integrate + repair | RD38 H readiness guards: compose real stager/verifier consumers; reject symlinks escaping to the Resources parent and broken links; exclude tests/fixtures from shipped runtime. Preserve the stable signer and atomic installer. | Release readiness |

All RD37 and RD38 C–I author trees were clean and committed at the recorded snapshot. Current exact tips are in the evidence appendix. Master A/B and seven source repairs are delivered too. None of these handoffs becomes installed acceptance merely by being committed.

## Additional original design and user controls

| ID | State | Original behavior still missing or narrower | Original checklist |
|---|---|---|---|
| UI01 | Port | Original coworker overview card: identity/Box, inline name, Share/bell, computer thumbnail, tile/row destinations and footer actions. Grouped in-panel Apps/MCP, Routines/Triggers, Activity/Logs and Settings/Capabilities/Install with breadcrumb/back/expansion. Current flat dialog launchers differ materially. | B1/B5/C8 |
| UI02 | Port | Files grid, type icons and media/text thumbnails in place of the common-icon text list. | D5 |
| UI03 | Port | Files arbitrary multi-file/folder import, drag/drop and queued progress/retry. The mounted Files importer currently takes one `.txt`/`.md`; chat attachments are a separate path. | D5/C3 |
| UI04 | Port | Safe general text/code editing using original binary/truncation checks, beyond the current `.txt`/`.md` editor limit. Retain conflict/hash protection. | D5/E2 |
| UI05 | Port | Download/save directly from Files and its previews. Saving a chat result card already exists and is a different entry point. | D5 |
| UI06 | Port | Shared Files panel generic import, media preview and download beyond text-only controls. Shared non-text chat cards/previews already exist and must be preserved. | D6 |
| UI07 | Port | Unified Company Brain pages/proposals/files/shared-database navigation, search and editor shared-file linking/drop. Current separate dialogs and page-only sidebar are narrower. | D8/D6/D7 |
| UI08 | Port | Describe-a-schedule parsing and localized schedule summary, replacing the raw cron/ISO-only convenience gap. The inspected original does not provide a calendar picker. | E8 |
| UI09 | Port | Per-routine connection/provider/model override. Chat and triggers already have model pickers; routine execution currently follows the coworker default. | E8 |
| UI10 | Port | Foreman industry starter packs/template choice rail and ask-choice/input/either/show-templates widget lifecycle. Current plan/build path covers only a subset. | E11 |
| UI11 | Port | Foreman rich messages, attachments/file cards, engine questions/approvals, feedback and regenerate. The ordinary coworker renderer does not supply these to Foreman's text/docs-only path. | E11/C5/C8 |
| UI12 | Port / decide feed | Getting-started progress/hide/reopen, Help/Docs/Community and conditional What's New feed/dialog/unread state. Native Mac does not need the original PWA-install control. | B5/E11 |
| UI13 | Port | Multiple named ChatGPT and Claude subscription connections with independent private profiles, login/reconnect/remove/default selection and immutable in-flight identity. Current `mac-chatgpt`/`mac-claude` singletons cannot support this; IN10 is API-key-only. | D3/provider settings |
| UI14 | Port | Original subscription usage/plan-limit windows and list meter. Mount genuine reported data; do not invent usage when no reading is available. | D3/provider settings |
| UI15 | Port / decide bounded scope | Original recent Logs window (100 versus Mac 50) and trigger-source presentation. No unbounded history or workspace-wide Logs screen was found upstream. | B5/R1 |
| UI16 | Port | Open a database row from Board/List/Gallery into the original all-fields detail sheet. This works upstream even without source attribution; current Mac has inline editing but no row-open/detail binding. Provider/source provenance is separately conditional in PL04. | D7 |

## Model operations and same-name semantic gaps

| ID | State | Remaining original operation / scope | Original checklist |
|---|---|---|---|
| TL01 | Port | `download`: binary-safe public URL download into coworker Files, with destination permission, safe network admission and durable outcome. Existing browser exports do not supply it. | E2 / UP-04 |
| TL02 | Port | `vision_analyze`: analyze an existing Files image with real model selection/resize path. Image chat input and screen interpretation already exist. | C3/E2 / UP-05 |
| TL03 | Port | `notify_user`: model-selected nonblocking attention, real destination/permission and recorded delivery. Completion/error notifications already exist. | C7 / UP-07 |
| TL04 | Port | Five `team_*` coworker-read tools plus separate default-off grant, owner scope and presenters. UI history and the external MCP API are different entry points. | E10/R1/E11 / UP-02 |
| TL05 | Port | `table_view_save` and `table_view_delete` model actions. Human saved-view editing is already ported. | D7 / UP-06 |
| TL06 | Port / decide interaction | `mcp_login`, `mcp_login_complete` and `mcp_status`: original fallback login/completion and model-visible inventory. Preserve human approval; also repair the existing sign-in entry point in FX02. | C6/E5/E7 |
| TL07 | Port / decide authority | Broader Foreman workspace reads/orchestration, cross-coworker files/skills/routines/triggers/data, connections/defaults, Boxes, templates and navigation. Original source inventory includes 35 enabled builtin/agent-file names before provider filtering (CLI providers use native search) and 57 brief tools; Mac currently admits only `show_plan`, `open_panel`, optional `read_company`, `search_docs`. Many underlying human controls already exist. Port appropriate operations with explicit confirmation, rather than equating those name counts to new features. | E11/B5 |
| TL08 | Port / decide inheritance | Delegates' controlled inherited tools and durable shared artifact output. Current isolated children receive explicit task/context and permitted public fetch, returning text only. Accepted call/delegate Stop/progress/history remains valid. | E10 |
| TL09 | Port | Original private-file regex search semantics. Current private search is literal case-insensitive; shared regex search already exists. | D5/E2 |
| TL10 | Port | Saved full-page continuation for truncated `web_fetch` output. Current fetch explicitly saves no full copy. Hub-rendered fallback is separately service-dependent. | E2 |
| TL11 | Port / decide write scope | Extension-agnostic safe UTF-8 private/shared read/write/overwrite breadth. Current private create and shared text operations are narrower. Preserve current conflict/revision/receipt guards. | D5/D6/E2 |
| TL12 | Decide SQL scope | Original broader SQL operation/result limits versus the current confined executor (including SQL views/triggers/virtual tables and some statement forms). Core private/shared query/execute/schema and human views exist. Do not weaken file/system protections just to match a name. | D7 |
| TL13 | Decide review boundary | `brain_write` for human-confirmed facts and Foreman Brain write/delete/proposals/decide. Mac deliberately forces proposals/human review; record and resolve that adaptation explicitly. | D8/E11 |
| TL14 | Decide workspace coherence | Shell commands run in the isolated Linux computer; Files tools use the persistent coworker Files store. Original shell uses its coworker workspace. Define artifact transfer/coherence without granting the Mac host shell. | E2/E3 |
| TL15 | Port / conditional adapters | External MCP's four share and twelve template operations are not registered, despite some corresponding local UI authorities. Its 37 account operations are source-registered with the mounted service binding; actual key scopes admit a subset. Review parameter differences too, including skill-file offset zero only. Reuse local authorities where equivalent; hosted expert/template/share semantics remain conditional. | W3/W4/D9 |
| TL16 | Decide self-improvement review | Original `mcp_register` immediately probes/saves; Mac proposes human review. Original `tool_install` installs workspace npm packages; Mac requires reviewed exact versions in the guest. Preserve those confirmation boundaries while explicitly deciding parity/artifact expectations. This is separate from missing login tools and installer QA. | E5/E7 |

The ordinary registry has **14 absent names**: download, vision_analyze, notify_user, five team names, two table-view names, brain_write and three MCP names. These map to grouped rows above, not 14 additional rounds. Eight hub discovery/install/publishing names are conditional in PL02. The sixteen external MCP names in TL15 are a separate caller surface, not sixteen additional local products. Dynamic third-party tool catalogs are not finite source inventories.

## Root repair queue

| ID | State | Required repair | Delivery / relation |
|---|---|---|---|
| FX01 | Repair first | External MCP `update_agent` must reject nested capability/self-improvement expansion and stop advertising unsupported authority fields. Current source permits this with a valid write-scoped key and enabled listener. Read-only keys cannot perform it; no exploitation was established. | Guard delivered `73b6855e`; before QA08 external writes |
| FX02 | Repair | `request_mcp_sign_in` is built but discarded by both subscription-provider filters: absent from grant catalog and not dynamically branded. Bind/admit it under the correct existing access checks. | Source confirmed in registry/providers; no executed reproduction this audit |
| FX03 | Repair | Contain bad saved cron/timezone computation per routine so later rows still run; validate by actual next-run computation. | UP-01; not in RD37 I |
| FX04 | Repair | Remove whole-batch attachment refusal above 14 and await/fold per-document outcomes into the conversation's real receipts. | Per-file outcome source delivered `2520a0ef` |
| FX05 | Repair | Native notification receipt must retain actual failed/unknown delivery instead of recording shown from the toast path. Keep the native channel. | Existing bridge/UI integration |
| FX06 | Repair | Share review counts and exclusion reasons must match the exact filtered archive. Existing credential-path exclusions already protect the archive; a count mismatch is not evidence of an archive secret leak. | IN07/E UI binding |
| FX07 | Repair | Persist board pan/zoom per workspace and restore the same location after full restart. | IsoGrid camera callbacks are not bound to durable workspace state |
| FX08 | Repair design | Replace the five coworker-panel sentence loading states with the original skeleton treatment. | UI evidence; preserve current error/refusal states |
| FX09 | Decide + repair | Reconcile direct Duplicate permission/enabled/env/MCP copying with the later fresh-copy/import rule. Portable imports already reset access. Specify the intended duplicate policy and enforce it without erasing accepted independent chats. | Original behavior / task-spec reconciliation |
| FX10 | Integrate repair | Guest Unicode clipboard/paste, preserving disabled extended clipboard. | Delivered `d7dc1685`; QA06 |
| FX11 | Integrate repair | Clear-memory must wipe/drain the semantic index as well as canonical notes. | Delivered `d0b2a798`; QA02 |
| FX12 | Integrate repair | Claude linked/pending authentication generation must describe the current attempt truthfully. | Delivered `4415d319`; QA01 |
| FX13 | Integrate repair | Non-text native writeback must report unsupported honestly rather than imply published Files bytes. | Delivered `42aa785f`; QA07 |
| FX14 | Integrate repair | Search credential revision/admission must prevent stale configuration use. | Delivered `aed68574`; QA04 |
| FX15 | Repair | Restored generic tool previews must not bypass secret redaction; pending/cancelled/unknown status must not all render as running. | RD38 D explicitly leaves these root consumer fixes; IN09 |

IN01/IN10 also contain provider-specific source findings; IN11 contains stager/verifier defects. Those are not hidden additional implementation tasks. Root repairs them during integration, rather than asking the user to send repair prompts back to authors.

## Configuration and root acceptance still required

| ID | Gate | Closure evidence still needed |
|---|---|---|
| QA01 | D3 / subscription | Real Claude account sign-in/reconnect/reply and saved login after restart; verify genuine native provider behavior. Codex's recorded successful journey does not establish Claude's. |
| QA02 | D4/D8 | Configure embeddings and prove related-note/page retrieval without shared keywords, fallback/offline/clear-index behavior and restart. Keyword recall is already implemented. |
| QA03 | C4 | Configured transcription, coworker and Foreman voice-send, retry/failure/cancel and mention rename/delete cases. Prior recording/review/discard was local only. |
| QA04 | E2/E4/E5/C6 | Real configured Rerun search, Bearer/custom-header service accounts, supported OAuth/SSE, sign-in/reconnect/rotate/revoke/Stop/restart. Unsupported method shapes remain PL03, not mere account setup. |
| QA05 | C3/C5/C6/C7/C8 | Mixed drop/paste/upload uncertainty and document outcomes; secure request lifecycle; latest tool/result/compaction presenters; actual macOS notification banner/click and truthful delivery. Preserve drafts, sibling chats and saved decisions. |
| QA06 | E3/E7 | Browser custom timeout, Unicode paste, guest installer/Stop and parent disconnect/shutdown using the reviewed guest. Existing navigation/takeover/terminal/command journeys remain accepted in their recorded scope. |
| QA07 | E2/W3/D9 | Non-text writeback refusal, template Delete/Rollback, broader archive fidelity and native withdrawal/recovery. IN07 memories/private-DB transfer requires fresh-copy/isolation/restart acceptance. |
| QA08 | W4 / whole integration | After FX01, accept external mutation/send scopes, receipt/retry/revocation and restart. Root alone then runs required source checks, packaged Mac board journeys, genuine provider replies and full restart for each integrated slice. Existing read-only MCP acceptance is preserved. |

## Conditional original-platform and release scope

| ID | State | Original scope / remaining authority |
|---|---|---|
| PL01 | Conditional + integrate | Remote machines: RD38 I journal/provenance helpers are delivered, but actual drain/close/bind/verify/publish callbacks and a compatible identity-challenge/gateway/session protocol are absent. Original `/health` is insufficient. Pairing/replacing/removing requires real target proof and root device acceptance. |
| PL02 | Conditional / port | Original eight hub catalog-discovery/install/list/uninstall and publish/unpublish/list model actions. Bind local equivalents where appropriate or supply the configured hub. Public Files/Brain/coworker publication, Published screens, password/auth/access/invites/revocation and published deep links need a real host. Publication is RELEASED in the original community build, not an EE-only dismissal. |
| PL03 | Port / conditional methods | Catalog OAuth explicit client/scopes/authorization-server overrides, SSE OAuth/custom headers, multi-server, secret-URL and shell method shapes currently refused. Record each supported/refused method truthfully; managed OAuth/Composio needs a broker/authority decision. A list of 209 catalog entries is not 209 implemented connections. |
| PL04 | Conditional service | WhatsApp Status/Linkup (UP-03), LinkedIn/WhatsApp paid Apps and new row/source provenance. Public code exists, but community paid Apps/billing are disabled; real account/broker/service and enabled-community applicability are prerequisites. Do not make disabled paid products compulsory local readiness. |
| PL05 | Conditional backend | Original REST v1/mobile-client backend is distinct from the Mac cookie-authenticated desktop routes and external MCP listener. Port/deploy the required routes, session/workspace authority and read/error/continuation contracts before calling the Mac mobile-compatible. |
| PL06 | Conditional multi-user | Workspace accounts/profile, invitations, membership/roles/admin/last-admin, ownership/leave/delete; execution-level Box visibility/use/manage, RLS and callable-coworker enforcement. ChatGPT login is provider authentication, not workspace identity. |
| PL07 | Conditional collaboration | Private realtime/presence and hosted feedback-transcript privacy; a real community email adapter plus configuration; real device-push delivery (community push adapter is a no-op). Existing local feedback stores no transcript snapshot and is already owner-checked. Hosted delivery requires matching server/session/membership authority. |
| PL08 | Conditional mobile | Original Expo mobile screens, auth, workspace/inbox/chats/files/apps/routines/settings/providers, desktop takeover and device notifications. Choose an original hub deployment or an explicit phone-to-Mac protocol; the current local MCP listener is not that protocol. Physical device acceptance remains separate. |
| PL09 | Release work | User-facing Mac update feed/rollback, stable signing/notarization, Intel/other architecture acceptance and reviewed public distribution. Bind IN11 and audit fork CI conditions/actual database-policy checks. The blocked Linux/systemd engine updater is not a Mac updater. |
| PL10 | Decide protection policy | Original content locks, template/skill/coworker protected-content rules and hosted attribution/paid-source contracts require explicit applicability. Local owner controls and permission restrictions are adaptations; do not copy EE commerce or weaken custody to claim parity. |

Original community-disabled phone entitlement, billing/purchases/payouts, paid Apps, marketplace commerce, support chat and Weekly Rewind are excluded from the enabled local-community completion requirement. Native Mac also excludes PWA installation. Their presence in a full-source tree does not enable the corresponding service.

## Crosswalk from every historical row

| Historical ID | Remaining register scopes (accepted recorded behavior stays preserved) |
|---|---|
| B1 | UI01, FX09 |
| B2 | PL06 for multi-user ACL; local Box geometry/actions accepted |
| B3 | TL03, FX05, QA05 for additional notifications; accepted attention navigation retained |
| B4 | UI10, IN03/IN07 for broader templates/Foreman; accepted manual creation retained |
| B5 | IN08, UI01/UI12/UI15, FX07/FX08, PL01/PL06 |
| C2 | IN04/IN05; accepted filters/queue/tabs retained |
| C3 | IN04, FX04, QA05; UI03 is separate Files import |
| C4 | QA03, IN04 |
| C5 | IN04/IN05, QA05; cross-references C6 rather than duplicate implementation |
| C6 | FX02, TL06, QA04/QA05 |
| C7 | TL03, FX05, QA05 |
| C8 | IN06/IN09, FX15, QA05, UI11 |
| C9 | Preserve accepted per-tab draft behavior throughout all integration; no separate missing draft feature found |
| D3 | UI13/UI14, FX12, QA01 |
| D4 | FX11, QA02 |
| D5 | UI02–UI05, TL09/TL11, FX08 |
| D6 | UI06/UI07, TL11 |
| D7 | TL05/TL12, UI07/UI16, PL04 provenance where applicable |
| D8 | UI07, TL13, QA02 |
| D9 | IN07, FX06, QA07, PL02 |
| E2 | TL01/TL02/TL09–TL11/TL14, FX13/FX14, QA04/QA07 |
| E3 | FX10, TL14, QA06 |
| E4 | QA04, PL02–PL04 |
| E5 | FX02, TL06/TL16, IN06, QA04 |
| E6 | Preserve accepted skill editor/bundle/proposal journey; PL10 if hosted locks/protected content are chosen |
| E7 | TL06/TL16, QA06; accepted self-instruction/length/master switch retained |
| E8 | UI08/UI09, FX03 |
| E9 | QA04/QA05 for remaining lifecycle where applicable; public ingress belongs PL02/PL05 |
| E10 | TL04/TL08; accepted explicit coworker calls and child Stop/history retained |
| E11 | IN03, UI10/UI11, TL07/TL13, UI12 |
| R1 | UI15; existing per-coworker Monitoring charts retained |
| W1 | PL01; accepted local workspace separation/switch retained |
| W2 | PL06/PL07 |
| W3 | IN07, FX06/FX09, TL15, QA07, PL02/PL10 |
| W4 | FX01, TL15, QA08, PL05 |

## Evidence, ownership and completion rule

Source evidence is split into [mounted UI coverage](desktop-parity-ui-coverage-20261106.md), [all tool-family/admission coverage](desktop-parity-tool-coverage-20261106.md) and [runtime/platform/author-handoff coverage](desktop-parity-runtime-coverage-20261106.md). Exact paths, line anchors, clean handoff commits, applicability and unknowns are retained there. The earlier [PR38 audit](desktop-upstream-pr38-audit-20261106.md) still records the 13-commit delta and UP-01–UP-07; it no longer serves as the total remaining list.

Root's next integration priority is FX01, then committed source and its central bindings, repairing findings directly. Independent design/tool ports can be planned from this register without reassigning delivered work. Existing A–I author worktrees and bases remain untouched.

A scope closes only when its code and intended permission policy are integrated, required checks pass, and root verifies the relevant board-to-panel journey, saved result, sibling isolation and full restart in the exact installed build. Configuration/host gates remain explicit. No tests, builds, installs or Mac actions were performed for this source/documentation audit; no earlier accepted journey was re-certified by it.

This is a broad source coverage register of the known remaining work, not proof that every line, third-party action, codec or live service has been exhaustively exercised. It intentionally records unknown/configuration/service boundaries instead of hiding them behind a finish-round promise.
