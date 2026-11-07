# Rerun runtime / authority parity audit

> Historical checkpoint: this document records its named source/build and predates
> the fork development reconciliation. Use the [current Mac status](desktop-macos-status.md)
> for integrated source and outstanding QA. Preserve the findings and acceptance
> evidence below; they do not establish acceptance of a newer app build.

Source review only, 2026-11-06. No tests, typechecks, lint, builds, installs, provider calls, app/UI actions, accounts, listeners, signing, or workspace-data inspection. Author worktrees were not changed. This is a missing-work map, not installed acceptance.

## Frozen sources

- Original official dev / PR38 merge: `ab3def9bfcf545cc9548f99c63c2b011ca094023`, `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/upstream-pr38-review-20261106`.
- Mac coding source: `b88a4f525e9c88a2ccd945d8d0e8d31edb1d6065`, `/Users/gszulc/OpenBot/Shared/rerun-desktop` (supplied installed runtime identity is separately `34c9cf39`; not independently inspected here).
- RD37 A–I: `9f6893da8c4d2180787833fd20989304a939c7c1`, `f816616020cf4ce68d7001fa2247de28c3f7c8ab`, `440d9b283aae1ed362eca3daab4aa05493ceaaef`, `dbecf4b398d844e158d9eeb3281d45e30d7b75d1`, `5d16ee6d625896735d7210715da786544d85a4e1`, `4342cde078f6ac01c633e5d4c368b0b307d14c69`, `66ea16bf66d3202558f16a44833c8077f0d7cf21`, `f0e1425743e86811109592ecca17c5031b5ed82d`, `32963bb5867df40a4c098126b1d47c3e0d9bb7fb`.
- RD38 master initially `2362ca1f350524031bfb60e817d355ee138b0aad`, latest clean tip observed `8297fe6404caa114dcb0c2cd6006291a8abb2038` (the added commit is documentation reconciliation; implementation list below unchanged).
- RD38 C–I freshly observed tips: C `80cdcab42e3aada421e546cfa4b85f9d1cb5d6a2`; D `7e1069903ad7a5926e41df159bc1fd4f0bba56b5`; E `7ceabd5400ab160b6aa809853f98dbb28f9a37d5`; F `72e8ef863fa353897115f46d363b7020e0282f63`; G `efdf4f0bd63a175fcb5e234e133d97d209f10d35`; H `62c7a5d81eabeed472c8ea90b277fd2ce1e24da0`; I `a9fa38881e30e31d5fa20e516bb7bbff562765b6`.

The historical checklist's 21 unchecked groups, the seven newer upstream packets, and the A–I source packages are different units. They cannot be added or subtracted as though each were one completed feature. A package with unbound ports is delivered source, not a working Mac feature. Absence of a live subscription/account does not mean the underlying code is missing.

## Complete category matrix for this lane

| Area | Current Mac source / received source | Actual remaining work |
|---|---|---|
| Normal Codex chat, device login, live model catalog, model/reasoning defaults | Integrated local adapter; prior acceptance is separate historical evidence | Preserve existing connection/catalog/default semantics; run exact integrated regression/restart checks after new composition |
| Multiple named Codex and Claude subscriptions | **Concrete missing authority**, not covered by named API work | Per-connection subscription auth/profile/custody/lifecycle and list/detail/default/removal UI; fixed Mac IDs currently prevent this |
| Four API-key providers | OpenAI, Anthropic, Google, OpenRouter integrated in existing single-source Settings | Multiple named API accounts delivered in RD38 F/G, still require migration/routes/UI/execution snapshot/drain binding and review fixes |
| Custom OpenAI-compatible providers | RD37 A/B source delivered, partial | Root canonical secure connection authority, durable requests/catalog revisions, registry and model dispatch, cancellation/lease/lifecycle, Settings/default selectors; address known source findings before activation |
| OpenCode Go / Console | RD37 C/D source delivered | Provider enum/token/registry/model dispatch, catalog/usage migration, authenticated routes, key authority, UI/default/removal/Stop/shutdown composition; live account/credit use separate |
| Claude plan | Local source auth/runtime present | User sign-in and real conversation acceptance remain configuration/QA; master also delivered stale-auth-generation repair; do not reassign a duplicate Claude implementation |
| Subscription plan-limit display | Shared runtime DTO/Claude collector exists, original UI exists, **Mac mount missing** | Reuse PlanLimitsBlock and source list meter in Mac subscription detail; do not invent provider usage readings |
| Provider failure/missing-chat recovery | RD37 H source delivered | Transport failed-run error, modelRevision, current chat notice mount, reconnect target, canonical retry; explicit first-turn no-session retry choice and unknown-admission reconciliation |
| Provider / tool protocol compatibility | RD37 I source delivered | Compose Codex unknown-errorInfo fragment into actual shipped existing patch; preserve every Mac hunk and CLI pin; mount turn ordering/repair/root schema normalization |
| Provider labels/config aliases/capabilities | Canonical catalog plus RD37 provider packages | Central exhaustive provider/capability/compaction/curator/vision/default mappings require composition; do not just add a Settings option that lacks execution support |
| Company profile / Foreman inference | RD37 E/F source delivered | Contract/migration/routes/C35 intake authority + exact revision/Stop/Quit binding; source evidence and explicitly selected no-tool model; no borrowed login or automatic provider fallback |
| Service catalog, anonymous/Bearer HTTP | Bundled catalog + genuine local adapter present | Current accepted example is not all catalog methods accepted; preserve per-method availability truth |
| Additional named service accounts | Account schema/compiler/lifecycle/custody source present | Live HTTP/OAuth/SSE additional-account lifecycle QA; this is different from multiple AI-provider subscriptions |
| Service HTTP custom headers | Account compiler source present | Root/live configured acceptance; do not infer from the old narrow base classifier alone that all custom headers are absent |
| Service SSE and stdio | Source transport/compiler/drivers present | Configured native QA/cancellation/drain; SSE only anonymous or exact Bearer; stdio reviewed programs/env/cwd/grants, no automatic execution |
| Catalog OAuth PKCE | Local source present | Configured live approval/reconnect/revoke/Stop/restart QA, limited manifest shapes |
| OAuth overrides and SSE OAuth | **Concrete unsupported method shapes** | Fixed client IDs/secrets, authorization server/scopes overrides and OAuth over SSE are refused; decide support/adapter rather than call entire E4 finished |
| Catalog multi-server / secret URL / shell methods | Deliberately rejected source shapes | Actual original catalog coverage needs per-method compatibility table; optional adapters must preserve explicit permission/custody; a catalog row alone is not implemented |
| Managed OAuth / Composio / paid Apps | Explicitly rejected locally; original hosted authorities exist | Host/account/broker/paid availability decisions and real adapters, not credential-only configuration; community build itself disables paid Apps |
| Linkup / WhatsApp Status / LinkedIn Pro | Original paid app families exist, PR38 adds Status | Conditional paid-host authority plus Status tool/session/result lifecycle. Source inclusion is not a free local account or proof it works |
| Custom MCP / credential requests | Existing local source bridges and grants | Root configured live SSE/OAuth/credential rotation, Stop and restart acceptance; preserve exact owner/run/connection fences |
| Schedules / routines | Integrated CRUD/run/history and lease/admission source | **Known missing bad-cron/timezone computation containment**; safe per-row failure so one bad schedule cannot block later rows |
| Local webhooks / triggers | Integrated loopback source includes custody, idempotency, rotation/history/recovery/human continuation | Root restart, rotate/disabled ingress and same-request behavior; external hosting is a separate decision, not a reason to discard local implementation |
| Public webhooks | No public Mac listener/host accepted | Host, auth, rate limits, revocation, account/remote access authority; conditional hosted milestone |
| Native host / guest screen / browser | Existing isolated guest/browser source | Root guest/browser end-to-end, custom timeout, Unicode paste, Stop, parent-disconnect/shutdown; Unicode paste repair delivered on master |
| Guest shell / package installer | Existing source, isolated runtime, approval/progress | Real authorized guest install/Stop/restart verification; no second installer or host-shell widening |
| Local workspaces / ownership | Source owner markers, install/workspace roots, per-workspace partition/credentials and switch coordinator present | Root installed recovery/custody/Stop/Quit verification after integration; board camera persistence is a separate confirmed root source defect |
| Remote machines | RD36 source and RD38 I durable transitions delivered | **Missing public remote identity-challenge/gateway/session contract and real physical callbacks**; local journal helper alone cannot connect. Optional host/protocol decision + actual native authority composition |
| Engine self-update vs Mac update | Original Linux git/artifact/systemd updater retained in tree but blocked by desktop route allowlist | Local atomic signed app install exists; user-facing automatic Mac updates, feed/rollback/signing/notarization are separate release work; never enable engine updater as Mac updater |
| Canonical signed preview / package staging | Existing stable signer and atomic canonical install | RD38 H source guards need root stage/verifier composition; public distribution/Intel/notarization/update feed unaccepted |
| Shutdown / ownership / diagnostics | Supervisor/current renderer/owned runtime/lifetime source present; H found no further proven defect in focused read | Root executable evidence; refuse fake remote ACKs or stopping whichever runtime is currently selected |
| External client keys/listener/API | Existing loopback default-off scoped API source | Integrate delivered W4 grant bypass guard before external writes; native auth/scope/revision/lifetime enforcement; listener not a phone protocol |
| Portable coworker memory/database | RD38 master A/B source delivered, E UI now committed | Canonical capture/install readers/writers, barrel/migration/transfer seam binding; clear unavailable only after authority bound; fresh identity/no grants/no chats |
| Hosted publication / template market | Offline share/templates source exists; hosted original code is account/host dependent | RD44 host/auth/access/revocation/ACL decision; do not activate older unguarded /p route; template publishing/billing/creator payout not a local checkbox |
| Multi-user workspace accounts/membership | Original Supabase members/admin/last-admin/identity authority, Mac local profile is single-user | Account/session/identity authority, invite/leave/delete/ownership semantics + server enforcement; ChatGPT login is not workspace identity |
| Box ACL / collaboration / presence | Original explicit roles/visibility/space_members/RLS/realtime authority | Conditional hosted/multi-user design; port all enforcement layers together, not UI-only access controls |
| Mobile | Original Expo/Supabase/hub app present upstream; not Mac companion protocol | Choose original hub deployment or explicitly design phone↔Mac protocol; bearer+x-workspace-id is not existing desktop remote wire protocol |
| Community / enterprise feature gates | Original includes AGPL code and separate ee/(ee) commercial-license folders | Preserve community defaults and gates; full-source repository does not mean every paid/cloud authority is in local community runtime |
| Remaining tool parity | Seven upstream packets plus tool sibling's detailed map | Team read tools, binary download, saved workspace-image vision, saved table view mutators, notify_user, Status and cron are known; not an exhaustive product count |

## Newly confirmed gaps beyond seven upstream packets

### R1. Multiple named subscription connections (actual missing code)

Original `apps/ui/components/connections/AddProviderPage.tsx:31–33` explicitly supports distinguishing “Claude” twice; line52 creates a new connection. PlanConnect creates a new plan then renames on completion. Original `apps/engine/src/config/paths.ts:101–106` keeps a separate Codex auth/refresh lineage for each connection ID.

Mac `apps/engine/src/desktop/codex-runtime.ts:6,15` uses fixed `mac-chatgpt` and one `dataDir()/chatgpt` profile. `codex-login.ts:85–105` always mutates that ID. `packages/contracts/src/desktop-claude-plan.ts:3,8` fixes `mac-claude`; `desktop/claude-plan/runtime.ts:56–59` rejects any other ID. `desktop/policy.ts:12–14` allows subscription providers only for those fixed IDs. Settings hides additional provider creation once any connection for that provider exists (`DesktopSettings.tsx:43`).

RD38 F is expressly API-only: `packages/contracts/src/desktop-api-connections.ts:6` enumerates only `anthropic,openai,google,openrouter`, and F handoff explicitly excludes Codex/Claude/custom/OpenCode changes. Therefore F/G cannot close this gap. This is not solved by using another workspace.

Minimum coherent slice: exact connection IDs and private profiles, provider-specific secure credentials/session generation, independent start/poll/cancel/reconnect/disconnect/rename/remove, usage/removal consequences, model/default selection and immutable in-flight identity. Root must not turn on a list-only multiple subscription UI while runtime still reads the singleton profile.

### R2. Subscription usage windows are not presented in desktop (small source reuse gap)

Original `ConnectionDetail.tsx:93` mounts `PlanLimitsBlock`; `AiProvidersPanel.tsx:299` shows the tightest usage meter. Mac receives `planLimits` in connection DTOs, and shared `agents/claude-context.ts:58` records usage through `connections/plan-limits.ts`. No non-test Mac desktop component reads `planLimits`. Reuse original presentation and preserve unknown/no-reading state. A new provider usage API is not established as missing by this finding; Codex and Claude should only display genuine reported windows.

### R3. Service method coverage is narrower than “OAuth/SSE supported”

Original service manifest preserves OAuth `scopes`, `clientId`, `clientSecret`, `authorizationServer` (`apps/ui/lib/services/manifest.ts:19–24`) and stdio/SSE/http (`:32`); original method summary kinds are `oauth,key,stdio,none,managed,composio,app` (`types.ts:30`).

Mac `services/oauth/compiler.ts:9–15` supports only no-input, single-HTTP-server PKCE metadata/DCR without catalog overrides; explicit client ID/secret/authorizationServer/scopes are refused. `services/accounts/compiler.ts:176–182` rejects SSE OAuth and SSE custom headers. `services/transports/compiler.ts:40–46` rejects hosted methods, multiple servers and OAuth; lines62–77 restrict SSE/stdio executable/header shapes. Basic local HTTP anonymous/Bearer, custom HTTP headers, supported PKCE, and reviewed stdio are delivered source and must not be counted absent. The unsupported shapes remain real coverage decisions/source adapters, not merely “needs sign-in”.

## Already delivered, still root integration/review

### RD37 source packages

- A/B custom provider runtime/UI: secure canonical connection store/receipts/catalog revisions and central provider dispatch still root-owned. Existing review findings include shared global keepalive violating fresh DNS pin, same-workspace connection-switch stale form refs, non-durable mutation recovery, stale operation clearing newer busy state, stale manual context discard, and an unconditional 120s inference deadline. Do not call delivered partial source complete.
- C/D OpenCode: source wire adapters/catalog/limits and UI exist, but no central enum/key/runtime/model/resolution/Settings/route migration bindings. D explicitly returns unavailable before C ports are bound.
- E/F company profile: explicit source-backed typed inference; root C35 intake/Stop/Quit/routes/migration needed. Credentialed discovery sources remain unavailable; do not silently borrow ChatGPT/model credentials.
- G chat interactions: question v2 projection must preserve old IDs/fingerprints and only prepare new calls before persistence. Current owner/source/Stop and canonical same-ID receipt bind are mandatory. Voice transcript alignment stays absent until genuine saved metadata exists.
- H chat recovery: error fields/notice mount/retry/model revision/reconnect still root-owned. H itself lists first-turn no-session retry and budget-without-local-billing actions as limitations; recovery UI must not create duplicate admissions after unknown ACK.
- I compatibility: shipped Codex patch lacks unknown string/object errorInfo passthrough. `docs/desktop-round37-i-handoff.md:79` requires composing the provided fragment into **both** actual CJS/ESM sections of the existing patched dependency, preserving Mac hunks and Codex0.166.0. A fragment file is not an active repair.

### RD38 C–I source handoffs

Fresh D/E/G tips are committed, unlike stale master inventory prose. They are not automatically integrated or tested. C UI/tool presentation belongs to sibling audit. E must consume canonical A/B plan/manifest/exclusion authority; it must not independently count/archive credentials. F/G require canonical routes + SQLite receipt/revision migration + run admission snapshots + actual pending-run/drain authority; missing authority refuses removal. F source review blockers noted by master include secret-derived deterministic SHA256 receipts and credential-presence/probe ambiguity. G does not grant source authority by rendering the control.

H delivered pure guards, but current `scripts/desktop/verify-runtime.mjs:116–117` still misses a symlink resolving exactly to Resources parent (`..`) and silently ignores broken symlinks; `stage-main.mjs:15` still copies all tests/fixtures. Root must bind H guards into verifier/stager and correct stale unsigned packaging docs. Stable preview identity, canonical app path/bundle ID, atomic install and source receipts must remain intact. No public-release acceptance follows from source review.

I delivered durable effect reservation/receipt and observation provenance helpers. `docs/desktop-round38-i-handoff.md` explicitly states original `/health` and authenticated connection list do not provide stable install/workspace challenge proof; existing RD36 client expects `/desktop/remote-machine/identity?challenge=…`, not exposed by original. I's `canonicalRuntimePorts` is **refusal-only**. Root real `drainWork/closeOwnedRuntime/bindRemote/verifyTarget/publishTarget`, canonical store/actor/lifetime binding and supplied compatible remote protocol remain absent. Never wire refusal stubs just to satisfy method presence, never claim Connected from saved metadata, never release unknown custody after cancellation.

### Master delivered source repairs (all unintegrated/unaccepted in this audit)

| Repair | Exact implementation commit | Remaining root work |
|---|---|---|
| External MCP update_agent cannot expand grants | `73b6855e6d227011fcd6198ce3ee71f1d640a94c` | Integrate before external write enable, fix remaining Mac catalog projection, executable scope/refusal/restart checks |
| Guest Unicode paste | `d7dc1685e2b2648c7a61c29ade8fa8a7b95992d0` | Integrate and actual guest field/terminal/Stop checks; keep extended clipboard disabled |
| Per-document attachment outcomes | `2520a0ef3d483bd29c66e12fdb4ebfd37761a4bb` | Compose conversation await/fold results and remove whole-batch >14 refusal |
| Memory clear semantic-index wipe | `d0b2a79834261ad34e04abd4e9ce20e1f79cdc16` | Integrate canonical memory deletion/index drain and restart checks |
| Claude pending generation truthfulness | `4415d3193bc467d0f25cbd9fdfdb3d76bf5c65f8` | Integrate exact linked/pending attempt distinction, sign-in/race/Stop checks |
| Nontext native writeback unsupported receipt | `42aa785f9b72ca676bc473cab0f708f899db0d3f` | Integrate result projection; never silently drop scratch binary/document |
| Search rotated credential revision classification | `aed685747b0ee88fad99e90bf870650be997d990` | Integrate configuration/credential generation and error classification |
| Portable memories source | `cb7a184d918e45899574c37232c43dba1261bd44` | Bind canonical list/install/index and shared A/B/E digest/availability seam |
| Portable private DB source | `1e1b6ea138ff3e0c3051e2607304d0ea33260ec0` | Bind confined private DB logical schema/rows/views reader/fresh writer, no raw SQLite/SQL replay |

## Existing unrepaired root queue (separate from new feature packets)

1. Engine cron safe computation and per-row scheduler exception containment (`schedules/cron.ts:25,33`, `runtime/scheduler.ts:235,248`). Current helper can throw before later rows; UI mirror already catches. Cron constructor validation alone is insufficient for invalid timezone/compute failures.
2. Same-box Duplicate copies grant-bearing config and inherited enabled state; portable import already strips grants/connections/chats. Master records explicit user no-inherited-grants requirement, so this is not settled by labeling it product decision. Credential/.env/MCP-file copying is a separate root product decision; do not broaden portable imports.
3. Share preview plan count/reason mismatch: count only actual included files, identify credentials separately from native grants; preserve ordinary hidden files and reserved `.rerun*` exclusions. Canonical `desktop/coworker-share/snapshot.ts`, not a UI-only second filter.
4. Board camera persistent per workspace: original IsoBoard read/write camera exists; current DesktopBoard doesn't pass initialCamera/onCameraChange. Same-session open/close retention does not prove restart persistence.
5. Five coworker panel loading sentences vs original skeletons; sibling presentation map can identify exact mounts.
6. Attachment >14 hard refusal and conversation not awaiting document outcome remain root central conversation changes even after hook package integration.
7. Native notification receipt must preserve actual notify success/failure; currently toast treats shown before receipt. Keep native bridge; do not mark OS notification delivered from toast alone.
8. F API connection security review: secret-derived fingerprint/receipt data, live connected vs credential-presence semantics, correct scope/actor/revision, actual pending-run drain, no false credential probe success. Not solved merely by mounting list/detail UI.
9. Root central provider enum/dispatch/availability/compaction/vision/curator/SDK patch composition for all RD37 providers; UI compatibility alone is insufficient.

## Authority and release conditions to preserve

- Current `apps/ui/lib/desktop/server/auth.ts:29–45`: exact Host, same-origin mutation, constant-time session-cookie match and workspace switching freeze; engine-internal endpoint requires distinct engine bearer (`:49–54`). New mounts must use existing desktopRoute and limited JSON readers; provider secrets never go in browser response/receipts/logs.
- Current `desktop-run.ts:65–82`: app-managed launch/IPC, loopback origin/port, API key, encryption key, install/workspace/data root and owner marker; route allowlist at `:127` blocks original `/update` even though generic HTTP server registers it. Generic original auth allows no-key mode (`http/auth.ts:6`); Mac launch explicitly refuses missing key. Do not interpret generic original route existence as local exposed capability.
- W4 bypass is confirmed current code: `external-mcp-tools/operations.ts:233–253` accepts tools/selfImprovement in update_agent; source guard delivered on master rejects authority fields before rename/move/patch, preserving ordinary metadata. Keys with coworkers:write are not permission to expand coworker grants.
- Original Box ACL is multi-layer authority: `_auth/access.ts:8–16,83–88` admin/space_members/workspace visibility; original member admin/last-admin semantics (`members.service.ts:33–61`) and Supabase RLS must agree with board/UI. Mac local profile is not a hosted member session.
- Mobile API `apps/mobile/src/api/client.ts:34–47` attaches hub bearer and x-workspace-id; no phone pairing wire is supplied by that client, remote machine allowlist or engine-pair service. Do not open the Mac external MCP listener to phone as an implicit port.
- Original `apps/ui/cloud-oss/apps.server.ts:9–15` returns paidApps=false/{} even with released LinkedIn/WhatsApp flags. `apps/ui/ee/LICENSE` separately restricts ee/(ee) production/distribution to agreement. This is source gate evidence; no licensing/legal conclusion beyond text is claimed here.
- Preserve single canonical `/Users/gszulc/Applications/Rerun Desktop Preview.app`, bundle `build.rerun.desktop.preview`, stable existing preview signer and Keychain continuity. Public notarization/update feed/architecture/distribution are not local preview acceptance.

## Limits / unknowns

This lane did not exhaustively audit every UI component or every tool parameter; sibling audits own those matrices. It did trace complete runtime categories and explicitly record unsupported service shapes. Live provider accounts, app sign-ins, embeddings/STT configuration, actual remote host, microphone, native notifications and device behavior remain unverified. Prior accepted local slices were not rerun or revoked here. Received source handoff prose is classification evidence, not executable proof. Before assigning more tasks, root should reconcile latest D/E/G commits and repaired master packages, then distinguish central bindings/repairs from truly missing independent source slices.


---

# Platform/API addendum to runtime parity audit

Bounded source-only check, 2026-11-06. Original `ab3def9bfcf545cc9548f99c63c2b011ca094023` at `upstream-pr38-review-20261106`; Mac `b88a4f525e9c88a2ccd945d8d0e8d31edb1d6065` at `/Users/gszulc/OpenBot/Shared/rerun-desktop`. No tests, builds, provider calls, app actions, CI runs, source edits or external mutations. Counts are source inventory, not accepted functionality.

| Platform slice | Evidence at original pin | Actual Mac state | Classification |
|---|---|---|---|
| Public REST v1 / mobile client contract | `apps/ui/app/api/v1/`: **95 files, 69 route.ts files**, including auth/client version/bootstrap, workspace/profile/members, Boxes/coworkers, conversations/feedback/history/search, providers/login/limits, service/MCP/skills/routines, desktop/takeover, inbox and devices | **No `apps/ui/app/api/v1` tree**. Mac has local `/api/desktop/*` equivalents for many operations, using a session cookie + same-origin mutation and private engine bearer | **Missing wire/API surface for full original-client parity; conditional on hub/mobile/external-client milestone.** Existing local operations are not missing merely because route names differ. Current desktop routes are not compatible with the original mobile app |
| Execution-level Box ACL | `_auth/access.ts:83–88` and `_services/chat.service.ts:22–34` enforce workspace + Box use/manage before browser, v1 and MCP reach service-role DB/engine. `supabase/migrations/20261105130000_space_access.sql:1–5,34–51,63–108` provides visibility, per-member Box scope, grants and RLS functions | Desktop checks local install/workspace/session/coworker ownership; has Box placement/roster integrity. No member actor/use/manage execution authority or associated SQL migration | **Missing multi-user authority**, conditional hosted/collaboration scope. Local ownership is an appropriate existing single-user equivalent, not a multi-user ACL implementation. A Box access dialog alone would not close it |
| Private realtime cursors + presence | `useTeamCursors.ts:52–56` creates a private channel; `20261104120000_realtime_cursors_private.sql` limits broadcast/presence topics to JWT workspace members. Heartbeat/idle/TTL in `lib/notifications/presence.ts` and presence service | Old web cursor hook remains in repo without `private:true`; new privacy migration absent. No desktop component mounts TeamCursors/PresenceHeartbeat/RealtimeSubscription. Local desktop polls/streams its own runtime and does not publish shared cursors | **Missing collaboration/private realtime port; conditional**, not evidence the current local board leaks a realtime channel. Do not enable the legacy shared web surface without its new policies and identity authority |
| Feedback privacy | `20261105150000_message_feedback_private.sql` revokes browser SELECT because votes copy entire transcript. `_actions/message-feedback.actions.ts` checks reachable coworker/session and uses server authority for reads/details/clear | Local `/api/desktop/sessions/[sessionId]/feedback` uses desktopRoute; `server/reply-feedback.ts:31–52,55–79` verifies exact coworker/session and a saved assistant message. Stores rating/category/details in local SQLite, **no transcript snapshot** | **Local equivalent/adaptation present**. Hosted transcript-feedback RLS migration remains missing if web/cloud mode is activated. Do not count local ratings as absent or blindly add upstream transcript collection |
| Email notifications / invitation/access codes | Original community `cloud-oss/email.ts:8–15` exposes real email services with optional Resend config; `email/client.ts:48–52` constructs client only with key. Notification service filters Box audience (`:208–216`), presence, preferences, incident suppression and throttling | Current `apps/ui/cloud/email.ts:9–17` explicitly has EMAIL_DELIVERY=false and returns skipped; local desktop has notifications/inbox + native Notification bridge (`main/notifications.mjs:13–46`) | **Email source adapter/mount missing for optional email parity**, plus mailer/account configuration; supplying a key alone will not enable current no-op adapter. Native local banners are a working distinct channel and do not equal email delivery |
| Phone push/device lifecycle | Original v1 `me/devices/route.ts:16–36` owns/revokes Expo device tokens with account transfer restrictions; `_services/push.service.ts:13,32–40,46–90` dispatches, caps and revokes dead tokens | No v1 device endpoints/mobile token authority in Mac; local native notification is not APNs/Expo. Original **community** `cloud-oss/email.ts:27–28` deliberately no-ops push because mobile targets Rerun Cloud | **Conditional mobile/hosted feature**, not a missing mandatory community Mac feature. Real phone delivery needs selected identity/hub/device/Expo/APNs authority and per-Box audience filtering |
| Fork CI / release gates | Official `.github/workflows/ci.yml:15,34,49` hard-gates jobs to `rerun-build/rerun`; release.yml:24 and version.yml:21 do likewise | Current Mac CI has no official-repo gate; triggers pushes only on main and PRs, with Linux contracts/types/lint/engine/UI/migration/image jobs. Current release tags v* publish owner GHCR engine image, without official-repo guard. No Mac package/native/signature/restart workflow in these files | **Fork-aware CI/release adaptation and Mac release gates remain source/release work.** Copying official workflows unchanged would skip fork checks; current fork workflow is not automatically skipped. Do not claim CI green from YAML or trigger/publish tags as part of audit |

## REST / identity boundary

Original `v1/_lib/api-route.ts:10–13,50–61` has public/user/member/admin authentication, Supabase bearer user validation, workspace membership and admin gates, then uniform 401/403/404 resource handling. `supabase/server.ts` reads request bearer and per-request workspace header; mobile client sends bearer + `x-workspace-id`. These are an entire shared client/server protocol, not a desktop allowlist entry. Original bootstrap is idempotent account provisioning (`v1/bootstrap/route.ts:8–17`). Mac's local bootstrap provisions the app's private profile/workspace, not such an account.

Mac `desktop-run.ts:118–127` enforces per-launch engine bearer, Host/Origin, stopping/initializing state and an explicit engine route allowlist. UI mutations use `server/auth.ts`'s cookie/origin/workspace freeze. Preserve those local controls; never expose private engine/UI credentials as a substitute for hub bearer sessions or a phone pairing protocol.

## External MCP: original 53 names vs mounted Mac admission

Original `apps/ui/lib/mcp/account-tools.ts:551` aggregates **37 account operations + 4 share + 12 template = 53**. Current Mac imports that catalog but **only admits the 37 account names** in `desktop/server/external-mcp-tools/catalog.ts:5–43`. The latter is not the entire 53-name catalog.

| Family | Original names | Current Mac listener source |
|---|---|---|
| Coworkers/Boxes (7) | list_spaces, list_agents, get_team_status, get_agent, create_agent, update_agent, delete_agent | Registered; read or coworkers:write scope. create_agent additionally requires runs:send and uses defaults. Known update_agent grant-bypass repair still needs integration from master before external writes |
| Models (2) | list_ai_connections, set_default_model | Registered; read/coworkers:write; local supported-provider/default authority applies |
| Skills (5) | list_skills, get_skill, read_skill_file, upsert_skill, delete_skill | Registered; read/coworkers:write. read_skill_file explicitly accepts **offset 0 only** (`catalog.ts:47,64–65`), so name parity is not complete parameter parity |
| Schedules (4) | list_schedules, upsert_schedule, run_schedule_now, delete_schedule | Registered; read/schedules:write, local scheduler authority |
| Triggers (5) | list_triggers, upsert_trigger, test_trigger, rotate_trigger_token, delete_trigger | Registered; read/triggers:write, local loopback/grant/networking authority; public hosting not implied |
| Runs (3) | send_message, list_runs, get_run | Registered; runs:send/read; exact run/receipt/runtime authority |
| Private/shared tables (6) | list_tables, db_query, db_execute, list_space_tables, space_db_query, space_db_execute | Registered; read/data:write; local table/query/write boundaries still apply |
| Connectors (5) | search_connectors, list_connectors, list_agent_connectors, attach_connector, detach_connector | All five source-registered in **actual mounted route**, subject service availability/grants and read/connectors:write. Last three omitted if ServicesAuthority absent |
| Sharing (4) | plan_agent_share, create_agent_share, list_agent_shares, revoke_agent_share | **Not registered / unsupported on external keys**. Local portable share UI/runtime source exists separately; this is a missing external adapter, not absent local sharing. Hosted share semantics remain conditional |
| Templates (12) | list_templates, get_template, create_template, update_template, submit_template, withdraw_template, delete_template, list_capture_sources, plan_template_capture, capture_template_agents, remove_template_agent, add_template_image | **Not registered / unsupported on external keys**. Some local library/import/template operations already exist, but original expert sandbox authoring/publishing/account authority is not supplied by exposing local import routes |

The service-gate correction matters: `external-mcp-tools/factory.ts:14–16` passes `servicesBound=Boolean(options.services)`. **Actual mounted** `app/api/desktop/internal/external-mcp-tools/route.ts:6–9` injects `createExternalMcpServicesAuthority` from canonical local binding. Therefore source capacity is **37 account names**, not 34. Without that binding it would be **34 + 3 dependent**, with 16 unsupported in either case. Connector attach still requires explicit supported method ID/values and cannot automatically complete OAuth/browser flows; listing a catalog name is not installation success.

The default key has only mcp:read (`contracts/desktop-external-mcp.ts:24–29`), so it cannot see/call the full 37. `external-mcp-authority/service.ts:305–317` filters actual tools/list by live key scopes, and `:320–342` rechecks tool admission and requires a request UUID for effects. Key revocation/expiry, workspace/install/launch identity, frozen/stopping state and current grants remain authority. **37 is source-registered capacity, not a live listener acceptance result**. Listener remains default-off; no key/listener was activated in this audit.

## Work that should remain on the full map

1. Public REST/client protocol with identity/version/workspace/error contracts, if original mobile/hub interoperability is a product requirement.
2. Enforced multi-user Box ACL + private realtime/presence + notification/feedback recipient privacy together, if collaboration is selected.
3. Optional real email path and independently gated phone push/device lifecycle; keep local notification implementation distinct.
4. External MCP 4-share/12-template adapters or explicit unsupported product scope, plus per-tool parameter parity and the already delivered external-grant repair.
5. Fork-aware checks and Mac packaging/native/signature/release validation; official image release YAML does not establish Mac release readiness.

These are not sixteen new local features simply because sixteen MCP names are missing. Some reuse existing local authority, some require hosted expert/template/account contracts, and others are deliberate community gates. No hosted CI, deployment, user account, device or native behavior was verified here.
