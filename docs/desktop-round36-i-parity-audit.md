# Round 36 I — Original-code parity audit (static evidence)

**Evidence class:** static source / handoff / acceptance-doc review only.  
**Not Mac acceptance.** No tests, typechecks, builds, installs, servers, provider calls, Docker, native/browser UI, Keychain, microphone or restart checks were executed by this lane.

## Exact pins and working copies

| Role | Revision / path |
|---|---|
| Prepared audit branch | `desktop/round36-remaining-parity-audit` @ `970415507e28824bb001f46c8537d20fd2636b1c` (verified clean before edits) |
| Historical original design/acceptance pin | `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` |
| Current reviewed original fork | `2a57fa6dd53311f763bfc9abde85997b7f7e5309` at `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/upstream-review-20261106` |
| Round35 native workspace integration reference | `052f6f66f8f8eaca27d5ea878d2cf3024e617dc0` (`packages/contracts/src/desktop-workspaces.ts`, `apps/desktop/src/main/workspaces/**`) |
| Current coding-tree HEAD (concurrent evidence, not this branch) | `094155338c122f2ee3227f86b4e58a54ec782b99` |
| Latest recorded installed source in Round35/C35 docs | `7b6c6a101519bdb7482169871270c77a76af0dcc` |
| Upstream update + review read before writing | `…/outputs/Rerun upstream update for all agents.md`, `…/outputs/Rerun upstream review November 6.md`, root `docs/desktop-upstream-review-20261106.md` |
| Canonical checklist in this worktree | `docs/desktop-parity-checklist.md` (**21 capability groups remain**) |
| Remaining-list mirror | `…/outputs/Rerun remaining checklist.md` |

**Concurrent-root note:** root HEAD advanced past the Round35 reference (`052f6f66…`) through C35 integration and inventory docs. This audit consumes Git objects / docs for exact contracts and does not reset, rebase, cherry-pick or create a second workspace catalog.

**C35 status distinction:** the assignment text said “C35 remains in progress.” Later static evidence (Round35 acceptance, C35 intake acceptance, root integration) records the committed handoff integrated with root repairs; native draft/save/navigation/Skip/restart passed; **final live completion/reply still awaits ChatGPT device approval** in isolated workspace 2. E11 stays open. This audit does not treat that pending sign-in as acceptance.

## Method

1. Enumerate user-facing capabilities from **mounted** original UI, registered `apps/ui/app/api/**` and `apps/ui/app/api/v1/**` routes, Control Center command builders, and engine `apps/engine/src/tools/builtin/**` callers at pin `2a57fa6…` (with historical baseline `a6d63a4…` for checklist design).
2. Compare each open checklist group to installed/accepted evidence docs, Round35 A–I handoffs, Round36 A–H handoffs, and Mac desktop routes/components present on the coding tree / prepared base.
3. Classify each group as **implemented** (closed on checklist), **partial**, **missing**, **unsupported** (Mac/local boundary), or **QA-only** (source/native present; live provider/user/native acceptance outstanding). Static adapter presence alone never upgrades a group.
4. Separate Round36 A–H **assigned source** from unfinished root activation. Ownership forbids editing A–H code; unfinished work is inventoried here and in the backlog as root/activation packages.

Unused components, screenshots, EE stubs and mobile lab routes are **not** treated as Mac feature evidence.

---

## 1. Independent original capability enumeration (mounted / registered)

### 1.1 Primary desktop surfaces (AGPL core + community)

Observed mounted/registered families at `2a57fa6…` (non-exhaustive path inventory; callers traced where checklist-relevant):

| Surface | Original evidence | Mac relevance |
|---|---|---|
| Board + Boxes + coworker tiles | `IsoBoard`, `BoardContextMenu`, `BoardChatSplit`, box-access/controls | Core Mac product; B1–B4 accepted historically |
| Control Center | `ControlCenter.tsx` + `lib/control-center/commands.ts` | B5; many commands already Mac-adapted |
| Chat composer/tabs/queue/filters | `ChatComposer`, `OpenChatsTabs`, `AgentChatsList`, `QueuedMessagePill` | C2/C9 accepted; C3–C8 partial |
| Voice / mentions | `VoiceComposerControls`, `MentionAutocomplete`, `VoiceUserMessage` | C4 partial; STT unconfigured |
| HITL cards | `QuestionForm`, `ActionApprovalBlock`, `SecretRequestBlock`, `McpSignInBlock`, `TakeoverAsk` | C5/C6 |
| Actions inbox / notifications | `WorkspaceInbox`, notification settings | C7 |
| Run presentation | `ToolCallBlock`, cards, `SubRunTree`, `CompactionBlock`, `TableCard`, Computer panel | C8 |
| Files / shared files / Brain / tables / monitoring | Files panels, Brain workspace, data views, monitoring | D5–D8/R1 largely accepted; D4/D6-write open |
| Skills / schedules / triggers / apps / MCP / self | Agent panels + engine tools | E4–E9 / E6–E8 / E10 mixed |
| Foreman | `ForemanChatLayer`, intake/*, dock, routines, discovery tools | E11 partial |
| Templates | Create/library dialogs | W3 partial |
| Workspaces / servers / members / API keys / share | `WorkspaceSwitcher`, `ServersDialog`, `WorkspaceMembersDialog`, `ApiKeysDialog`, `ShareAgentDialog` | W1/W2/W4/D9 decision + Round36 source |
| Connections | Claude plan steps, provider dialogs, custom/OpenCode pages (new pin) | D3 + new provider delta |

### 1.2 Original Control Center command set (`commands.ts`)

Actions: New agent, Browse templates, New Box, Ask the assistant (when ready), Contact Support (gated), Recenter the board, Switch light/dark theme.  
Settings: Workspace settings, Members, Billing (gated), AI providers, API keys & MCP (admin + entitlement), Company Brain, Shared files, Account, Notifications, Keyboard shortcuts, What's new (changelog).

Mac deliberately treats **Members / Billing / Account / Contact Support / API keys** as hosted or decision-bound (`HOSTED_CONTROL_COMMANDS` in `apps/ui/lib/desktop/control-center-parity/commands.ts`). Browse templates / Ask assistant / Shared files / Company Brain / workspace settings / theme / shortcuts are present or accepted on later Mac evidence; remaining B5 gaps are mostly contextual actions and decision-bound entries.

### 1.3 Engine builtin tool families (registered modules present)

`filesystem`, `shared`, `shell`, `web`, `browser`, `computer`, `hub`, MCP pool consumers, `hitl`, `memory`, `brain`, `db`/`shared-db`, `cards`/`table-card`/`page-file`, `skills`/`skill-propose`, `schedule`, `trigger`, `call-agent`, `delegate`, `self`/`install`, `foreman`, `notify`, `vision`, plus paid-data stubs. Presence ≠ Mac enablement.

### 1.4 New pin-only / separate-boundary surfaces (`2a57fa6…`)

| Surface | Boundary | Audit classification |
|---|---|---|
| `apps/mobile/**` Expo iPhone client + `/api/v1` hub | Separate product; Supabase bearer; no local engine | **Unsupported** for current Mac shell (decision required for any phone↔Mac pairing) |
| `apps/ui/(ee)/**`, `apps/ui/ee/**`, billing/credits/marketplace | Commercial license | **Unsupported** — inventory only; do not import |
| `cloud-oss` Rewind/paid-app fallbacks | Disabled community stubs | **Unsupported** as product features |
| Custom OpenAI-compatible + OpenCode model UIs | New provider scope | **New delta** — not in the historical 21 |
| Publishing / ShareDialog access changes | Hosted or local-offline adaptation | Overlaps D9; Round36 E/F local portable path |
| Box member `none/use/manage` grants | Multi-user | Overlaps W2 |
| Voice transcript display / missing-session recovery | Chat UX | C4/C8 follow-up delta |
| REST `/api/v1/**` hub routes | Mobile/cloud clients | Not Mac `/api/desktop` authority |

### 1.5 Historical closed groups (checklist `[x]`, not reopened)

B1, B2, B3, B4, C2, C9, D5, D6 (shared **read**/isolation only), D7, D8, E6, E8, E10, R1 — treated as accepted Mac evidence per checklist/acceptance docs. This audit does not re-litigate them except where a remaining open group cross-references them.

---

## 2. Open checklist groups — state matrix (prior-pin 21)

States: **partial** = meaningful Mac progress with residual scope; **QA-only** = source/native present, live acceptance/provider/user step outstanding; **missing** = no honest Mac product path yet; **unsupported** = requires explicit non-local decision or out-of-boundary; **cross-ref** = tracked elsewhere.

| ID | Title | State | Exact evidence (static) | Residual user-visible gap |
|---|---|---|---|---|
| B5 | Full Control Center + workspace customization | **partial** | Checklist + Round34/35 CC acceptance; Mac `DesktopControlCenter*`, `control-center-parity/*`; hosted commands excluded | Remaining contextual board actions; API keys/Members/Servers/Account/Billing not productized as hosted originals; do not invent Billing |
| C3 | Multi attach + media in chat | **partial / QA-only** | Image/PDF/SVG subset accepted in listed SHAs; drop/paste automated coverage “native acceptance outstanding”; broader media model inputs remain | Full native drop/paste/progress acceptance; broader model media inputs |
| C4 | Voice notes + mentions | **partial / QA-only** | Mentions accepted `40aa370`; mic record/review/discard `eac4c2b`; Round35 F local Foreman voice recovery; STT/send/playback unaccepted | Transcription provider config + send/playback/retry; broader mention rename/delete QA |
| C5 | Other interactive requests | **cross-ref → C6** | Checklist explicitly: remaining secure flows owned by C6; not an extra implementation task | Keep as checklist row; do not allocate duplicate build work |
| C6 | Credential / app sign-in / takeover | **partial / QA-only** | Takeover under E3; suggested-app cards + fake credential restart evidence; Round34 fake credential + Learn tool; **real** credential-backed sign-in unaccepted | Real provider sign-in lifecycle; remaining secret/MCP sign-in acceptance |
| C7 | Actions inbox + notifications | **partial / QA-only** | Inbox/Done/read receipts/toasts installed; **macOS banner/click acceptance unobserved** | Native banner/click QA; no full archive view (original also lacks it) |
| C8 | Follow a run in conversation | **partial** | Large card/media/delegation/Computer panel evidence; “remaining result-file formats and tool/request presentations” | Residual formats/presentations; compaction counts not persisted (known) |
| D4 | Memory controls + recall | **partial / QA-only** | Clear-all + keyword recall accepted; Round35 E semantic source; **live related-note without shared keywords unaccepted**; embeddings unconfigured | Live semantic-only retrieval once embeddings configured |
| E2 | Workspace writeback + web fetch | **partial** | Private writeback + reviewed writeback + web_fetch accepted slices; Rerun web search source-integrated awaiting configured-provider live acceptance; Round36 A owns shared write/edit/search | Provider web-search live QA; arbitrary binary writeback unsupported; shared mutations depend on R36A + root |
| E3 | Browser / computer | **partial / QA-only** | Isolated browser + Terminal/Files Round34/35 evidence; custom-timeout and non-Latin-1 clipboard **unrecorded** | Those two native acceptance items; Docker/guest image prerequisite remains |
| E4 | Service catalog apps | **partial / QA-only** | Catalog + HTTPS Streamable + Microsoft Learn accepted; Bearer fixture-only; OAuth/SSE/additional-account live pending | Real OAuth/SSE/managed methods lifecycle |
| E5 | Custom MCP | **partial / QA-only** | HTTPS + stdio accepted slices; SSE + real OAuth sign-in unaccepted | Live SSE + OAuth |
| E7 | Improve itself | **partial / QA-only** | Master/tools grants + MCP proposal save accepted; guest package install + broader lifecycle pending | Guest install lifecycle acceptance |
| E9 | Webhook routines | **partial** | Local create/delivery/HITL Round34 accepted; **external hosting pending** | Hosting decision + external URL exposure |
| E11 | Foreman team build | **partial / QA-only** | Round34 Box create; Round35 research/brief/routines/dock/voice; C35 intake integrated, **live completion pending sign-in** | Live intake completion; optional inference; richer research/profile fields; broader lifecycle |
| W3 | Templates | **partial** | Local capture/install/portable export accepted slices; deletion/rollback/hosted publishing outside acceptance | Broader fidelity + deletion/rollback; hosted publish unsupported without decision |
| D3 | Claude subscription | **QA-only / decision** | Steps + isolated runner installed Round34; **real account sign-in not tested** (user participation pending) | User sign-in + reply + persistence QA |
| D9 | Publish file / share coworker | **partial (local) / decision (hosted)** | Round36 E/F portable snapshot source committed; original Create link / public host not Mac-default | Root activate local share; hosted link needs explicit host decision |
| W1 | Workspaces + machines | **partial** | Round35 local create/switch/recovery **accepted** per remaining checklist; Round36 G/H remote client **source only**, inactive | Remote pairing decision + root activation; no live pairing in agent work |
| W2 | Invite teammates | **unsupported / decision** | Original Members/Account/CursorOverlay; Mac excludes Members from CC parity | Explicit multi-user decision; ChatGPT login ≠ workspace account |
| W4 | External MCP API | **partial (source)** | Round36 B authority + D UI + C partial reads committed; listener default-off; not installed acceptance | Root barrel/routes/bridge/listener binding + native QA |

---

## 3. Duplicates, cross-references, and reconciled-count proposal

### 3.1 Cross-reference / non-additive rows

| Row | Finding |
|---|---|
| C5 | Checklist states remaining secure flows are **C6**; C5 is not a separate build package |
| B5 ∩ C7 | Notifications commands vs inbox — shared surfaces; closing native banner QA is primarily C7 |
| B5 ∩ W4/D9/W1/W2 | CC entries for API keys / share / servers / members are gateways into those groups, not extra groups |
| D6 closed vs Round36 A | Accepted D6 is **shared read/isolation**; A extends **write/edit/search** under E2/D6 residual — do not reopen D6 as unread |
| E3 ∩ C8 | Computer panel presentation vs browser/computer runtime — keep E3 authority, C8 presentation residuals |

### 3.2 Historical subtotal vs updated total

- Canonical checklist still says **21 open groups**. This audit **does not change** that count.
- Upstream review: the 21 are the **prior-pin subtotal**; new pin deltas must be classified separately before any new total.

### 3.3 Proposed honest reconciled view (for root only)

**Keep canonical open count = 21** until root edits the checklist.

Proposed internal bookkeeping (not applied):

| Bucket | Suggested count | Contents |
|---|---|---|
| A. Cross-ref only | 1 | C5 |
| B. Decision-required / unsupported on single-user Mac without explicit choice | 4 | W2; hosted D9 link; E9 external hosting; mobile/EE (outside 21) |
| C. Round36 A–H source in flight (not acceptance) | 4 groups touched | D6/E2 shared mutations (A); W4 (B/C/D); D9 local (E/F); W1 remote (G/H) |
| D. Primarily QA-only / provider-or-user gated | ~8 | C3 drop/paste native; C4 STT; C6 real sign-in; C7 banners; D3 Claude login; D4 embeddings; E4/E5 OAuth/SSE; E3 clipboard/timeout |
| E. Partial product residuals needing more build beyond R36 A–H | ~6 | B5 contextual leftovers; C8 residual formats; E2 web-search live; E7 guest install; E11 after C35 live completion; W3 deletion/rollback |

**Defensible “remaining build packages after R36 A–H + root QA” ≈ 10–12 coherent packages**, plus **4 decision gates**, plus **new-pin deltas** (custom providers, Box ACL, voice transcript UX, phone↔Mac) tracked outside the 21 until root promotes them.

**Do not** claim the Mac is “10 groups from done”: several of the 21 remain open even when mostly implemented.

---

## 4. Round35 source vs root activation (cross-check)

Canonical workspace contract consumed (do not fork):

- File: `packages/contracts/src/desktop-workspaces.ts` @ `052f6f66…` / present on coding tree  
- Version: `DESKTOP_WORKSPACES_CONTRACT_VERSION = 1`  
- Native: `apps/desktop/src/main/workspaces/{catalog,coordinator,copy,isolation,paths,ports,receipts,index}.mjs`  
- Remaining checklist: local create/switch/recovery/cold restart **passed**; remote still Round36

Round35 agent handoffs (all in root `docs/desktop-round35-*-handoff.md`; integrated per Round35 acceptance with root repairs):

| Agent | Topic | Static outcome vs residual |
|---|---|---|
| A | Company discovery | Accepted research slice; enrichment/citation fidelity bounds remain |
| B | Company brief → Brain | Accepted selected brief/edit/dismiss slice |
| C | Intake | Integrated `7b6c6a1…`; **live completion pending sign-in** |
| D | Workspace Routines | Accepted paused manual run / reopen slice |
| E | Semantic Brain | Source integrated; live semantic-only unaccepted |
| F | Foreman PTT | Local clip recovery accepted; provider STT not claimed |
| G | Foreman dock | Placement/scroll/Quit slice accepted |
| H | Docs help in Foreman | Documentation citations retained after restart |
| I | Local workspaces | Native lifecycle accepted for local portion; author handoff noted missing authorities that root later bound |

**No competing workspace catalog** appears in Round36 A–H contracts inspected; they reference numeric `workspaceId` bounds aligned with `desktopWorkspaceIdSchema`.

---

## 5. Round36 A–H completion audit (docs-only ownership)

Assignment evidence exists for all eight Round36 A–H prompts under `…/outputs/Agent {A–H} round 36 prompt.md` and worktrees. User line “If any work from agent A–h is not done complete it” is reconciled as: **audit unfinished requirements into backlog/activation fragments; do not edit A–H lanes or claim their code complete.**

| Agent | Worktree HEAD (full SHA) | Claimed source | Unfinished / blocker (exact) |
|---|---|---|---|
| A | `c7ad1341eb053593824a577cf3234153f1ca444a` (impl `b37039967b53f50564c2a2ca2c6ee47febba85c1`) | Shared create/edit/search source | Root: contracts barrel, grant id, registry, route, schema/migration, binders; unbound → throw before write |
| B | `9e81e11110e09aeb05266068c332b44fdee38496` | Keys + default-off loopback MCP authority (`DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION=1`) | Root: runtime authority bind (W1 A1–A3), routes, barrel, enable remains refused until bound |
| C | `5af023dda412a21f77dec9ea86a66f2cabf72286` | Inventory + **5 read tools** + dispatch fence | **Not full catalog**; missing engine↔UI authenticated bridge; mutations/tables/routines/triggers/connectors unimplemented |
| D | `48d072d2229083ef35bb801109c24afcafc0f8d8` | Original API keys UI | Depends on B management routes + journal schema + CC/menu mount |
| E | `29e6a9deb6ae69e01eb40ad38ac4499b9e56f9b8` | Portable share snapshots | Root migration/routes/store init; no public links |
| F | `bab8cdc1bc980605d1f725bc45e138db216984cf` | Share preview/export/import UI | Depends on E + root offline picker bridge |
| G | `abffeb7d71f2a973f7c4951d244498e30cea05dd` | Remote machine lifecycle adapters | Root IPC/supervisor/gateway; no live pairing; hosted Docker token flow unsupported |
| H | `12d9bbf91e6a626367d2772965fd24e8f7fec7e6` | Servers dialog UI | Depends on G + barrel/route/mount; hosted pairing-token flow unsupported (truthful copy) |

**None** of A–H are installed Mac acceptance. **None** were completed by this audit lane.

Ownership/upstream blockers for code beyond I docs: **root activation**, **B→C bridge**, **canonical W1 runtime ports for non-1 workspaces in prepared-base `DesktopRuntime` literals where still present**, and **explicit product decisions** for hosting/multi-user/remote.

---

## 6. Decision-required capabilities

| Capability | Why decision is required | Local adaptation that preserves intent (if any) |
|---|---|---|
| W2 members / presence | Multi-user accounts, invites, live cursors | Keep single-owner Mac; omit Members/Account CC entries (current) |
| D9 public share links | Needs a host for outsiders | Round36 E/F offline archive import/export (no publish authorization implied) |
| E9 external webhook URL | Public/network exposure | Keep local loopback triggers; external hosting separate |
| W1 remote machines | Pairing widens trust boundary | G/H manual address+key client; default inactive |
| W4 external MCP listener | Opt-in local client access | B default-off loopback only; no LAN/public |
| D3 Claude subscription | User account participation | Keep API-key path separate; subscription QA when user signs in |
| Mobile phone↔Mac | Different auth/transport | Unsupported until designed paired revocable transport |
| EE billing/marketplace | Commercial license | Inventory only; never enable in Mac package |
| Custom/OpenCode providers | New pin policy | Port only behind existing Keychain/catalog/cancellation rules after explicit allocation |

**Never** treat local preparation as consent to publish, pair, listen externally or upload user data.

---

## 7. Uncertainty register

- Prepared branch `9704155…` predates Round35 merge; file presence on this branch understates installed Mac. Status judgments prefer **acceptance docs + coding-tree Git objects**.
- Round36 C handoff contains an early “B not published” section and a later resumption; status uses the **later** section + HEAD SHA.
- Official `rerun-build/rerun` advanced beyond the fork during review; cron containment candidate is recorded in upstream review but **not** in fork pin — track as root runtime port, not a new checklist group.
- No live app DB/credential/preview inspection was performed; “accepted” means **documented root acceptance**, not re-verified here.

---

## 8. Explicit non-claims

- Canonical checklist count unchanged.
- No group marked complete by this audit.
- No A–H code completed or repaired here.
- No checks executed; not installed acceptance.
