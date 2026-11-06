# Rerun upstream PR38 audit and missing-work supplement

**Scope correction:** this is the 13-commit delta and selected-gap supplement, not the full remaining product inventory. [The later full source register](desktop-parity-full-register-20261106.md) covers the older mounted UI, all model-tool families, provider/runtime/platform boundaries and delivered source as well. The seven packets below must not be read as all remaining work.

Reviewed November 6, 2026, against official `rerun-build/rerun` **dev** at `ab3def9bfcf545cc9548f99c63c2b011ca094023`; the ref was rechecked at 14:41 CST. Previous source reference: `2a57fa6dd53311f763bfc9abde85997b7f7e5309`. GitHub comparison and local Git agree: **13 commits, 104 changed files, 2,527 additions, 1,529 deletions**.

Mac code reviewed: `desktop/m1` at `aa34e94db923d682944f661655ad0b41604707cc`; installed runtime remains `34c9cf39a2240e2b6122e8414ebb4f9f74b61697`. Finished RD37 handoffs and master source tip `2362ca1f350524031bfb60e817d355ee138b0aad` were distinguished from installed behavior. This was a static source/ownership audit, with one read-only local listener-state observation. No app behavior, source runtime, permissions, accounts or listeners were changed; no tests, provider calls or posting were executed.

Sources: [official repository](https://github.com/rerun-build/rerun), [PR38](https://github.com/rerun-build/rerun/pull/38), [exact comparison](https://github.com/rerun-build/rerun/compare/2a57fa6dd53311f763bfc9abde85997b7f7e5309...ab3def9bfcf545cc9548f99c63c2b011ca094023).

## What PR38 actually adds

PR38 was merged into `dev` on November 6 at 12:29 CST. It adds WhatsApp's `post_status` model tool: text or a public image/video URL, optional caption/style, and audience numbers. Its adapter uses Linkup's content/create operation. Only two WhatsApp tool/test files change; it does not redesign the board or chat. The author reports unit coverage and explicitly has not tried real posting through a Linkup account.

This is absent from the current Mac. Copying the small tool declaration would not activate it: the Mac has no WhatsApp/Linkup app adapter, and its Apps compiler refuses this managed app method. The public community fallback also disables paid apps without a Linkup account. See [the tool](https://github.com/rerun-build/rerun/blob/ab3def9bfcf545cc9548f99c63c2b011ca094023/apps/ui/lib/apps/whatsapp/tools.ts#L85), [community fallback](https://github.com/rerun-build/rerun/blob/ab3def9bfcf545cc9548f99c63c2b011ca094023/apps/ui/cloud-oss/apps.server.ts#L9), and Mac `apps/ui/lib/desktop/server/services/catalog/availability.ts:73`, `services/compiler.ts:9`, `services/accounts/compiler.ts:86`.

## Seven explicit implementation/repair packets

These are not seven new rounds or seven additional whole checklist groups. Two concern new upstream capabilities, one is an already recorded but unimplemented reliability fix, and four are older tool residuals that the master task list did not name precisely. Keep the existing round numbering and source ownership.

### UP-01 — scheduler containment and actual timezone computation

**State:** source-confirmed missing engine repair. **Owner:** root repair/integration, not a repair prompt returned to an author. **Placement:** E8, RD42 local readiness; prioritize before release acceptance.

A malformed saved routine can throw while computing its next run and skip later routines in the tick. The outer scheduler catch keeps the process alive but does not isolate the bad row. Desktop writes validate an Intl timezone/Cron constructor without forcing next-run computation. Port the original safe calculation and compute-based validation through the actual desktop schedule-write paths. Preserve valid saved tasks; one invalid task must not halt the rest.

Important correction: RD37 I does **not** deliver this fix. Its handoff explicitly excludes cron. The old I backlog already recorded this as root-owned P2.8; the broad master phrase suggesting scheduler compatibility was covered must not hide it. The UI next-run mirror already catches timing errors and should not be reimplemented.

Original: [cron repair](https://github.com/rerun-build/rerun/blob/ab3def9bfcf545cc9548f99c63c2b011ca094023/apps/engine/src/schedules/cron.ts#L22). Mac: `apps/engine/src/schedules/cron.ts:25`, `runtime/scheduler.ts:235`, `desktop/schedule-tools/lifecycle.ts:57`. RD37 evidence: `round37-runtime-compatibility/docs/desktop-round37-i-handoff.md:104`.

### UP-02 — coworker team-read tools and permission

**State:** missing model-facing source package. **Placement:** E10/R1/E11 residual, RD40; display metadata joins the existing presentation work after its owner hands off.

Port `team_status`, `team_list_schedules`, `team_list_triggers`, `team_list_runs`, `team_get_run`, with the original **See other coworkers** control, icons, labels and activity descriptions. The current external-client `get_team_status` is a different principal and does not supply this coworker capability.

Use canonical workspace-scoped read ports with current caller, target, workspace and run admission checks. Introduce a separate **default-off** Mac grant; do not inherit upstream's default-true flag. Explain that another coworker's historical runs can include connected-app data. Keep trigger URLs/secrets private; do not expose API keys or require the external listener for model reads. Saved-run inspection must not execute work.

Original: [five tools](https://github.com/rerun-build/rerun/blob/ab3def9bfcf545cc9548f99c63c2b011ca094023/apps/engine/src/tools/builtin/team.ts#L9), [bridge](https://github.com/rerun-build/rerun/blob/ab3def9bfcf545cc9548f99c63c2b011ca094023/apps/ui/app/api/_services/team-hub.service.ts#L20), [permission UI](https://github.com/rerun-build/rerun/blob/ab3def9bfcf545cc9548f99c63c2b011ca094023/apps/ui/components/agent/AgentPanelTools.tsx#L53). Mac: `packages/contracts/src/desktop-tool-grants.ts:3`; `apps/engine/src/tools/registry.ts:72`; `apps/ui/lib/desktop/server/external-mcp-tools/operations.ts:123`.

### UP-03 — WhatsApp Status through a real Apps connection

**State:** missing, service/account gated. **Placement:** E4, RD40 managed-App integration.

Treat WhatsApp/Linkup account custody, actual service dispatch and the original setup flow as dependencies. Preserve per-coworker access, current connection identity, redaction, Stop, truthful failures and exact audience/content. The new status tool is one operation in that family, not a standalone adapter pasted into a catalog.

Do not enable the community paid-app flag without a real supported authority. Do not invent a connected account, publish a Status or message contacts during source work. Root needs separate specific posting authorization for any live acceptance; source fixtures do not prove successful real delivery.

### UP-04 — download a public asset into coworker Files

**State:** older missing tool, currently listed unavailable. **Placement:** E2, RD40.

Implement the original `download` action as a bounded binary-safe public-URL download into the owning coworker's Files. Keep the existing stronger Mac public-destination checks, run cancellation, confined atomic publication, path restrictions, clash handling and receipt recovery. Do not overwrite unrelated files, write host paths, create internal metadata or execute downloaded content. Use explicit Mac permissions and the existing file-publication authority.

Original: [web download](https://github.com/rerun-build/rerun/blob/ab3def9bfcf545cc9548f99c63c2b011ca094023/apps/engine/src/tools/builtin/web.ts#L167). Mac: `packages/contracts/src/desktop-tool-grants.ts:47` and desktop registry omission. Existing web-page reading/search does not implement persistent binary download.

### UP-05 — analyze an image already saved in Files

**State:** older missing model tool. **Placement:** C3/E2, RD40.

Port the autonomous `vision_analyze` behavior for an existing coworker-owned image. Manual image attachment already works; it is a different workflow. Reuse bounded image readers, accepted format checks, exact owner identity and the chosen supported model/connection. Keep cancellation, truthful unsupported-model behavior and credential isolation. Do not silently select or charge another provider, read another coworker's files, or add image generation as an invented requirement.

Original: [vision tool](https://github.com/rerun-build/rerun/blob/ab3def9bfcf545cc9548f99c63c2b011ca094023/apps/engine/src/tools/builtin/vision.ts#L68). Mac: grant catalog `:58` remains unavailable and desktop registry omits the vision family.

### UP-06 — model-created and model-deleted saved table views

**State:** older missing model actions; existing human view editor remains accepted. **Placement:** D7 residual, RD40.

Port `table_view_save` and `table_view_delete` through the existing validated private/shared table/view authority. Preserve correct database grants, view identity, column/filter/layout validation, concurrent-edit behavior, exact deletion target, saved-view navigation and restart. Deleting a view must not delete table rows. Do not turn the frozen `card_table` read permission into implicit write authority.

Original: [saved-view tools](https://github.com/rerun-build/rerun/blob/ab3def9bfcf545cc9548f99c63c2b011ca094023/apps/engine/src/tools/builtin/cards.ts#L44). Mac: `apps/engine/src/desktop/card-table.ts:27` explicitly limits the flow to the human editor. The old D7 acceptance did not establish these model tools.

### UP-07 — nonblocking coworker attention notifications

**State:** older missing model tool. **Placement:** C7, RD39.

Port `notify_user` using the original attention/unread behavior and exact coworker/session/run identity. It informs the user while work continues; it is not a question, approval, completion or error event. Preserve human acknowledgement, dedupe, delivery outcome, restart and permission checks. Keep the existing native channel and in-app behavior; failed/unknown native delivery must not be recorded as shown. Root performs any OS permission and actual banner/click acceptance.

Original: [notification tool](https://github.com/rerun-build/rerun/blob/ab3def9bfcf545cc9548f99c63c2b011ca094023/apps/engine/src/tools/builtin/notify.ts#L10). Mac: grant catalog `:62` remains unavailable and desktop model registration is absent. Existing automatic completion/error notifications are not this action.

## Priority source repair already delivered — do not reassign

**External API permission guard:** static review confirms that an enabled listener and valid `coworkers:write` key can currently submit nested authority-bearing `update_agent` fields outside the advertised narrow schema. This can change desktop grants for later runs. A read-only key cannot reach this operation; no unauthenticated access or exploitation was established. The currently selected workspace's listener was observed **off** during this audit.

Master commit `73b6855e6d227011fcd6198ce3ee71f1d640a94c` provides a narrow early refusal before mutations. Bring that existing fix forward through root review, regression execution and approved acceptance **before enabling external write scope**. Also repair the Mac catalog projection: it still advertises `tools`/`selfImprovement` fields that the new adapter refuses. Keep the original non-Mac account schema intact where its authority differs.

Current chain: `packages/contracts/src/desktop-external-mcp.ts:244`; engine `desktop/external-mcp-tools/dispatch.ts:41`; UI `server/external-mcp-tools/operations.ts:252`; engine `http/routes/agents.ts:128`, `desktop/native-grants.ts:26`. Delivered guard: master `operations.ts:107,260`. This is root's integration repair queue, not a new assignment sent back to the author.

## All 13 upstream commits accounted for

| Commit / PR | Audit disposition |
|---|---|
| `ab3def9b` / #38 | WhatsApp Status — UP-03; Linkup/service gate |
| `1368ba99` / #37 | Developer private-cloud checkout failure reporting; no local Mac feature |
| `2d1bdc20` / #36 | Five coworker team-read tools, permission and presenters — UP-02 |
| `07c863a6` / #33 | Docker CI input filtering; distribution/build review, not Mac runtime |
| `33eefeb0` / #32 | Hosted billing/payment-auth recovery; no local community Mac feature |
| `9961cb8a` / #31 | CLA document/workflow removal; contribution metadata, not a Mac feature or a licensing interpretation |
| `842c7872` / #30 | Hosted plan/coworker-cap policy and related copy; community billing remains disabled |
| `f1f00fe5` / #29 | Web account CAPTCHA fallback; conditional W2/account scope |
| `ba28349a` / #28 | Public version/release CI; review under RD42/RD45 before adopting |
| `a6295e04` | Branch integration, no separate user feature |
| `c93bd04a` / #26 | Linux artifact-updater cache/trim cleanup; do not apply Linux root-filesystem operations to the Mac installer |
| `0b6944f3` / #27 | Web signup phone flow; distinct from native provider sign-in |
| `7c75e331` / #22 | Scheduler/timezone safety — UP-01 |

The UI delta contains no general board/chat layout redesign. The mobile delta changes one subscription-related line; it adds no phone-to-Mac transport. The public community defaults still disable paid apps and Rewind, so those source directories do not prove an active self-hosted feature. Hosted/EE billing code was not adopted or approved.

## Already delivered source — integration and root checks remain

At clean master tip `2362ca1f` these nine packets exist. None is installed acceptance, and no duplicate implementation assignment is needed:

| Packet | Source commit |
|---|---|
| Portable memory capture/restore ports | `cb7a184d` |
| Logical private database transfer ports | `1e1b6ea1` |
| Unicode guest paste | `d7dc1685` |
| Per-file document attachment results | `2520a0ef` |
| External update-agent grant guard | `73b6855e` |
| Semantic index wipe on memory clear | `d0b2a798` |
| Claude replacement-generation state | `4415d319` |
| Unsupported nontext writeback receipt | `42aa785f` |
| Search credential-revision outcome classification | `aed68574` |

A/B require root's aggregate exports, canonical capture/install adapters and fresh-destination binding. Their Share options must remain unavailable until both directions are bound. RD37 now has nine clean committed handoffs, including D OpenCode UI `dbecf4b3`; those are still pending root review/integration. The Codex compatibility fragment needs root composition into the actual shipped patch; a written fragment is not runtime activation.

## Remaining repair queue from the master audit

These are repair/integration tasks for root and already assigned surface owners, not new rounds:

1. Oversized attachment batches currently reject the whole selection; retain admissible files and name overflow.
2. The conversation caller must await and account for the delivered per-file document outcomes when assembling batch status.
3. Native notification bridge failure/unknown must not persist a shown receipt; keep the native channel.
4. Share plan counts/exclusion labels must match archive filtering. Credential paths are already filtered from the archive; this is not evidence of a credential archive leak.
5. Board pan/zoom needs workspace-scoped persistence while preserving chat-inset behavior.
6. Five loading states need the original skeletons: Files, Memories, Settings, Schedules, Tools.

Duplicate's grant and credential-file inheritance needs explicit reconciliation with original behavior and the current spec. The master prompt's general rule names imports, while RD41 explicitly names copies/imports. Do not infer a user instruction from an author's quoted outside-task label. Record the source/spec discrepancy and resolve it through root; this audit neither changes clone semantics nor enables permissions.

RD38 C–I retain their existing owners. Observed local handoffs: C `80cdcab4`, F `72e8ef86`, H `62c7a5d8`, I `a9fa3888`. D/E have no local committed delta at this snapshot; G has uncommitted work. That does not prove work elsewhere is absent or authorize overwriting/reassigning their trees. No author worktree was modified.

## Qualified scope and remaining decisions

- Model-driven service-catalog discovery/install is not fully equivalent to the existing Apps UI plus `suggest_service`; review the remaining original hub actions under E4. Publishing/unpublishing needs D9 hosting. This is a qualified follow-up, not an assertion that every hub action is missing.
- The dedicated Mac Foreman surface is implemented. Its tool scope is narrower than the original Foreman; Brain writes deliberately require human review. Preserve that boundary and record the adaptation under E11/D8 rather than blindly enabling direct model write/delete.
- Paid data needs its provider/billing authority; the original also gates whether it is offered. Community Rewind is a no-op. Do not invent local feature tasks from these directories alone.
- Embeddings, transcription, Claude account sign-in and real OAuth/SSE need their recorded configuration/root acceptance. Source delivery is not a successful live provider connection.
- RD43 remote acceptance needs a compatible approved host. RD44 hosting/accounts/roles/presence needs real authority. RD45 mobile is a hub-client/protocol and distribution decision; engine pairing is not a phone-to-Mac protocol.

## Working rules and completion boundary

Keep the active assignments and their immutable bases. This supplement is for the next coherent package/checkpoint, not a request to rebase or interrupt working agents. Original-code/design references remain mandatory; new source authors may author meaningful regressions but execute no checks. Root owns all integration repairs, tests, typecheck, lint, build, native app/provider/guest use, permission decisions, restart acceptance and cleanup. Exact publication-head review precedes any approved draft PR push. No automatic merge, deployment or release.

The historical 35-row/14-accepted-slice/21-open-row record is not an exhaustive count of missing model tools. The explicit packets above attach to existing groups; they must not be hidden by a checked human-UI slice or counted again as seven whole groups. The later full register supersedes the scope of this delta report. The original 3–5 phase estimate is withdrawn pending integration and closure of that expanded register; no final numbered round establishes completion.

Coverage: all 13 new commits were classified, relevant community runtime/UI changes traced, the baseline tool catalog sampled against actual Mac registration/unavailable entries, and new master/RD37 source inventories checked. This is a bounded static audit, not exhaustive source approval of every optional service, all Foreman operations, hosted-account flow, MCP device-login variant, or the whole application. The installed runtime and current accepted Mac behavior were not changed.
