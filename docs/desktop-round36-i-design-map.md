# Round 36 I — Original design parity map

**Evidence class:** static comparison of original pin `2a57fa6dd53311f763bfc9abde85997b7f7e5309` (historical baseline `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`) against Mac desktop components on the coding tree / accepted docs.  
**Not visual QA.** Responsive requirements follow CLAUDE.md (≈375 / 768 / desktop widths and short ≈700px height).

## Board and Boxes

| Topic | Original reusable source | Mac state (static) | Concrete difference |
|---|---|---|---|
| Iso board, tiles, Boxes | `apps/ui/components/builder/IsoBoard.tsx`, `BoardContextMenu.tsx` | B1–B3 accepted; Boxes B2 accepted `414e325` | Mac retains original geometry/membership model; hosted plan-gated disable → manual Enable/Disable adaptation (documented) |
| Attention / Needs you | `lib/board/types.ts`, cyan waiting tile + raised hand | B3 accepted | Product copy should stay “Needs you”, not implementation status strings |
| Discoveries | `components/builder/discoveries/BoardDiscoveries.tsx` | E11 research findings partial | Board surfacing of discoveries follows original widgets; richer profile fields still residual |
| Camera / recenter | Control command `recenter_board` | Accepted via B5 slices | Keep original “Recenter the board” label |

**Reuse:** keep IsoBoard interactions, Box dialogs, ghost placement for templates (Round34), and BoardChatSplit chat selection rules.

## Chat

| Topic | Original source | Mac state | Difference / residual |
|---|---|---|---|
| Composer + attachments | `ChatComposer.tsx`, `AttachmentLightbox.tsx`, `AttachmentTile.tsx` | Multi text/image/PDF paths accepted with limits | Drop/paste native acceptance still outstanding (C3) |
| Tabs / filters / queue | `OpenChatsTabs.tsx`, `AgentChatsList.tsx`, `QueuedMessagePill.tsx` | C2 accepted | Preserve All/Chats/Automations/Needs you ordering |
| Drafts | `hooks/useComposerDraft.ts` | C9 accepted; Mac persists attachment selection (enhancement) | Do not regress per-tab draft identity |
| Voice | `VoiceComposerControls.tsx`, `VoiceUserMessage.tsx` | Mic record/discard accepted; STT/send open; Round35 F Foreman local clip | Original Send/Discard/Retry tooltips; Foreman PTT must use `type="button"` on non-send controls (R35 standard lesson) |
| Mentions | `MentionAutocomplete.tsx` | Selected mentions accepted | Broader rename/delete QA residual |
| HITL | `QuestionForm`, `ActionApprovalBlock`, secret/MCP/takeover blocks | Cards installed; real secret sign-in open | Original finishes as **new user turn**, not resumed process |
| Run chrome | `ToolCallBlock`, `SubRunTree`, `CompactionBlock`, `TableCard` | Large C8 acceptance set | Compaction counts not persisted; residual formats remain |
| Computer inline | `AgentDesktopView.tsx` | Panel + Terminal/Files accepted Round34/35 | Preserve hide/reopen during live run; guest Stop semantics |

## Foreman

| Topic | Original source | Mac state | Difference |
|---|---|---|---|
| Chat layer / welcome | `ForemanChatLayer.tsx`, `ForemanWelcome.tsx`, `ForemanComposer*.tsx` | Present; intake gated for empty chats | `ForemanSignupGate` / hosted signup **excluded** on Mac |
| Intake wizard | `components/foreman/intake/**` (`steps.ts`, company → optional industry → role → optional name) | C35 integrated; live completion pending | Preserve Back/Skip/edit/copy; no invented “needs” step |
| Dock / float / park | `ForemanDock.tsx`, `useForemanDrag.ts`, placement classes | Round35 G accepted placement/scroll | Publish layout as presentation only — do not recenter board camera from dock callbacks |
| Routines tab | `ForemanRoutines.tsx` | Round35 D workspace Routines accepted slice | Group paused tasks; open exact result chat |
| Research / brief | foreman engine tools + board discoveries | Round35 A/B accepted slices | Bound enrichment; no confidential inference from unrelated files |
| Voice | Foreman composer + Round35 F | Local saved clip only unless STT configured | Do not imply provider transcription from UI chrome |

## Dialogs and workspace chrome

| Dialog | Original | Mac | Notes |
|---|---|---|---|
| Workspace settings / logo | `WorkspaceSettingsDialog.tsx` | Accepted logo/illustrations | Keep preview/upload badge + atomic Save/Cancel |
| Create workspace | `CreateWorkspaceDialog.tsx` + `WorkspaceSwitcher.tsx` | Round35 local switcher/dialogs accepted | Strip sandbox/subscription seat copy for single-user Mac |
| Servers | `ServersDialog.tsx` | Round36 H ports original layout; hosted Docker token flow unsupported | Keep “Enter address and key”, “Add a server”, Remove confirm copy; truthful unavailable for pairing-token |
| API keys | `ApiKeysDialog.tsx`, `McpSnippets.tsx` | Round36 D ports list/create/revoke/snippets | One-time secret; loopback snippets only; no public URL |
| Members / Account | `WorkspaceMembersDialog.tsx`, `AccountDialog.tsx` | Excluded from Mac CC parity | Decision-required (W2) |
| Share coworker | `agent/share/*` (`ShareAgentDialog`, options, safety, link) | Round36 F maps to offline export/import | Replace “Create link” hosted climax with local archive export while preserving configure → safety → review ordering |
| Templates | `CreateTemplateDialog`, `TemplateLibraryDialog` | Local capture/Use again accepted | Hosted marketplace/submit unsupported |
| Keyboard shortcuts | shortcuts dialog via CC | Accepted; only working Mac shortcuts listed | Do not list non-functional originals |

## Settings and connections

| Topic | Original | Mac | Difference |
|---|---|---|---|
| AI providers | `AiProvidersDialog` + connection pages | Codex/ChatGPT paths in use | Claude **subscription** steps installed; live sign-in QA pending (D3) |
| Custom / OpenCode | `AddCustomProviderPage.tsx`, `OpencodeModels.tsx` @ new pin | Not in historical 21 | New delta — forms must not bypass Keychain/catalog policy |
| Notifications prefs | `NotificationChannels.tsx` | Installed; native banner click unobserved | Keep preference isolation per coworker |
| Billing / Pro badges | CC `paid` badge + billing store | Disabled / excluded | Do not show fake Pro upsell on Mac |

## Files, Brain, inbox

| Topic | Original | Mac | Difference |
|---|---|---|---|
| Files panel / preview | `FileDetail`, `FilePreview`, `AgentPanelFiles` | D5 closed with broad preview set | Folder create / cross-folder move absent in pinned Files UI — do not invent without design decision |
| Shared files | shared tools + panel | Read/isolation accepted; R36A write/edit/search source | Panel mutation UI still unsupported in A matrix |
| Brain | `BrainWorkspace.tsx` | D8 accepted; semantic live QA open | Keep proposals Accept/Dismiss original flow |
| Actions inbox | `WorkspaceInbox.tsx` | Pending/Done accepted | No full archive view in original — do not add as “parity gap” |

## Connections / apps / MCP panels

| Topic | Original | Mac | Difference |
|---|---|---|---|
| Apps catalog | `AgentPanelServices.tsx` | E4 partial | Managed/paid methods residual |
| MCP panel | `AgentPanelMcp.tsx` | E5 partial | SSE/OAuth live residual |
| Tools / Improve itself | `AgentPanelTools.tsx` | E7 partial | Guest package install residual |

## Workspace switcher / multi-workspace UX

Original `WorkspaceSwitcher.tsx` mixes workspaces, account, providers, API keys, servers, members, brain, templates and sandbox entry.  
Mac local lifecycle (Round35) should expose **create / rename / switch / busy/retry** with product-language blocked-switch copy, while routing Servers/API keys/Members through their own decision-bound entries rather than reintroducing hosted session chrome.

Reusable originals: create/rename dialog structure, busy/cancel, list selection — not subscription seat summaries or expert sandbox.

## Responsive / short-window notes (Foreman intake + dialogs)

Original intake includes compact/short-window/focus behavior (`ForemanIntakeCard`, `AnimatedHeight`, step components). C35 QA recorded a header anchoring overlap that root repaired — design map requirement: intake header must stay above the card in short viewports. Dialogs with illustration columns must stack on narrow widths (CLAUDE.md). Round36 H explicitly supports narrow/short Servers viewport in source claims (unrun).

## EE / mobile design

Do **not** port React Native layouts into Electron. Mobile screens are evidence of hub API shape only. EE marketing/billing UI is out of license boundary for the Mac package.
