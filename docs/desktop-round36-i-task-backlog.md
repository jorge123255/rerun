# Round 36 I — Prioritized task backlog (post–Round36 A–H)

**Root reconciliation, November 6:** This is the author's source-time audit, not the current installed verdict. `desktop-round36-integration.md` supersedes old C35-pending, unbound RD36 P0.1–P0.4 and five-read C statements. Installed `34c9cf39` has the complete received C catalog/bridge and accepted local read-only MCP, shared mutation and offline Share slices; remote gateway/transition, memories/database transfer and external service gates remain explicit. Approximate package arithmetic here does not replace the canonical 21 unchecked whole-group subtotal. Existing template cleanup, guest install and RD37-owned transcript/provider/profile work must not be allocated again as absent implementation.


**Rules:** excludes duplicate allocation of assigned Round36 A–H implementation lanes. Unfinished A–H requirements appear as **root activation / dependency** packages only.  
**Not acceptance.** Root owns repairs, checklist count edits, all execution checks and release.

Priority bands: **P0** blocks trust/safety or unblocks multiple lanes; **P1** closes near-complete user journeys; **P2** residual fidelity; **P3** decision-gated / new-pin deltas.

---

## P0 — Root activation for committed Round36 A–H source

### P0.1 Activate shared-file mutations (Agent A)
- **Checklist:** D6 residual / E2 shared write path  
- **Depends on:** existing shared root + grant catalog  
- **Owned paths (existing A source):** `apps/engine/src/desktop/shared-file-mutations/**`, `apps/ui/lib/desktop/server/shared-file-mutations/**`, `packages/contracts/src/desktop-shared-file-mutations.ts`  
- **Root work:** export barrel; persist `sharedFilesWrite` grant id; register tools; authenticated POST route; additive schema/migration; bind both ports  
- **User-visible outcome:** coworkers with write grant can create/edit/search shared `.txt`/`.md` without touching private files  
- **Original refs:** `apps/engine/src/tools/builtin/shared.ts`, `fsTools.ts`  
- **Evidence:** A handoff `c7ad1341…` / impl `b3703996…`

### P0.2 Activate external MCP authority + UI (Agents B, D)
- **Checklist:** W4 / B5 API keys entry  
- **Depends on:** canonical workspace runtime ports (installId, launchNonce, admissionsFrozen)  
- **Root work:** contracts barrel; management routes; runtime authority bind; listener default-off; journal schema; mount D dialog from CC/menu  
- **User-visible outcome:** admin can create/revoke loopback keys and copy local snippets; listener stays off until explicit enable  
- **Original refs:** `ApiKeysDialog.tsx`, `app/api/mcp/account/route.ts`  
- **Evidence:** B `9e81e111…`, D `48d072d2…`

### P0.3 Bridge + finish external tool catalog (Agent C residual)
- **Checklist:** W4  
- **Depends on:** P0.2 live recheck; authenticated engine↔UI bridge (missing in A–H source)  
- **Root work:** implement canonical internal bridge; register C dispatch; then allocate **new** lane only for remaining tool families (tables/routines/triggers/connectors/mutations) — do not reopen C’s worktree from I  
- **User-visible outcome:** external client `tools/list`/`tools/call` returns real workspace-scoped reads; unsupported ops explicit  
- **Evidence:** C `5af023dd…` (5 reads only)

### P0.4 Activate local coworker share (Agents E, F)
- **Checklist:** D9 local adaptation  
- **Depends on:** E store/service; confined picker  
- **Root work:** migration; `/api/desktop/coworkers/[agentId]/share` routes; mount F UI; offline file bridge  
- **User-visible outcome:** preview/export/import portable coworker archive without public links  
- **Original refs:** `components/agent/share/**`  
- **Evidence:** E `29e6a9de…`, F `bab8cdc1…`

### P0.5 Activate remote-machine client adapters (Agents G, H) — decision gate first
- **Checklist:** W1 remote portion  
- **Depends on:** explicit product decision to allow remote pairing on Mac  
- **Root work (only after decision):** IPC/preload; supervisor close hooks; barrel export `desktop-remote-machines`; mount Servers dialog; no automatic reconnect on startup  
- **User-visible outcome:** manual address+key pair/replace/remove with original Servers copy; hosted Docker token flow remains unavailable  
- **Evidence:** G `abffeb7d…`, H `12d9bbf9…`

---

## P1 — Close near-complete journeys (QA-heavy or small build)

### P1.1 C35 Foreman intake live completion
- **Checklist:** E11  
- **Depends on:** user ChatGPT device approval in QA workspace 2  
- **Owner:** root native QA (not a new agent lane)  
- **Outcome:** intake completion creates one Foreman turn; restart recovers acknowledgement without duplicate conversation  
- **Evidence:** C35 acceptance pending sign-in; installed `7b6c6a1…`

### P1.2 Voice transcription + send (C4)
- **Checklist:** C4  
- **Depends on:** configured STT provider decision  
- **Suggested owned paths (future allocation):** `apps/ui/components/desktop/chat/voice/**`, engine voice route bindings already sketched by R35 F  
- **Outcome:** record → transcript → send/playback/retry with draft-safe non-submit controls  
- **Original refs:** `VoiceComposerControls.tsx`, `VoiceUserMessage.tsx`

### P1.3 Native notification banner/click (C7)
- **Checklist:** C7  
- **Owner:** root native QA + any thin desktop notification bridge gaps  
- **Outcome:** macOS banner open navigates to exact coworker/session

### P1.4 Claude subscription live sign-in (D3)
- **Checklist:** D3  
- **Depends on:** user participation  
- **Owner:** root QA  
- **Outcome:** subscription login persists and produces a real reply

### P1.5 Semantic memory live retrieval (D4)
- **Checklist:** D4  
- **Depends on:** embeddings provider configuration  
- **Outcome:** related-note recall without shared keywords; offline keyword fallback remains

### P1.6 Composer drop/paste native acceptance (C3)
- **Checklist:** C3  
- **Owner:** root native QA of existing automated coverage  
- **Outcome:** drop/paste/progress/retry/cancel accepted on installed app

### P1.7 OAuth / SSE live acceptance (E4 / E5)
- **Checklist:** E4, E5  
- **Depends on:** real provider accounts  
- **Outcome:** OAuth sign-in and SSE connections survive restart with grant isolation

### P1.8 E3 clipboard + custom timeout acceptance
- **Checklist:** E3  
- **Owner:** root native QA  
- **Outcome:** non-Latin-1 clipboard + custom timeout recorded

---

## P2 — Residual product fidelity (new build packages; not A–H duplicates)

### P2.1 Control Center contextual leftovers (B5)
- **Outcome:** remaining board-contextual actions match original where local authorities exist; hosted commands stay omitted  
- **Suggested paths:** `apps/ui/lib/desktop/control-center-parity/**`, `components/desktop/DesktopControlCenter.tsx`  
- **Original refs:** `ControlCenter.tsx`, `lib/control-center/commands.ts`

### P2.2 Remaining run presentation formats (C8)
- **Outcome:** residual tool/request presentations and file formats; keep Computer/delegation already accepted  
- **Suggested paths:** `components/desktop/DesktopAssistantReply*`, card tiles under `components/desktop/**`  
- **Original refs:** `ToolCallBlock.tsx`, attachment/card components

### P2.3 Rerun web_search live provider binding (E2)
- **Outcome:** configured-provider live search acceptance without weakening Mac fetch binding  
- **Note:** preserve stronger Mac numeric-destination fetch per upstream review

### P2.4 Guest package install lifecycle (E7)
- **Outcome:** Improve-itself guest installs with review/restart semantics  
- **Original refs:** `tools/builtin/install.ts`, `self.ts`

### P2.5 Template deletion / rollback fidelity (W3)
- **Outcome:** delete/rollback portable templates without hosted publish  
- **Original refs:** template dialogs + local portable archive authorities

### P2.6 Foreman richer research/profile fields (E11)
- **Outcome:** optional industry/site/name inference only when explicitly bound; no confidential ambient inference  
- **Depends on:** P1.1 completion first

### P2.7 Codex errorInfo compatibility patch (runtime)
- **Outcome:** unknown `codexErrorInfo` does not drop terminal notifications  
- **Owner:** root shared patch composition (upstream review priority #1)  
- **Refs:** upstream `ai-sdk-provider-codex-cli` patch; keep Codex 0.166.0

### P2.8 Cron exception containment port
- **Outcome:** one bad saved routine cannot stop the scheduler tick  
- **Owner:** root; based on official `dev` delta beyond fork (static note only)

---

## P3 — Decision-gated / new-pin deltas (allocate only after explicit choice)

| ID | Decision | If yes, package intent | If no |
|---|---|---|---|
| D-W2 | Multi-user members/roles/presence | Port Members dialog through local accounts authority | Keep omitted |
| D-HOST-D9 | Public share links | Hosted revokeable URLs | Keep E/F offline only |
| D-HOST-E9 | External webhook hosting | Authenticated public trigger URL | Keep local triggers |
| D-REMOTE | Enable remote machines | Finish P0.5 QA with real host | Leave G/H inactive |
| D-EXT-MCP | Enable external listener by default policy | Still opt-in per key UI; policy doc only | Remain default-off |
| D-MOBILE | Phone↔Mac transport | Separate paired revocable design | Unsupported |
| D-EE | Commercial modules | Out of scope / legal | Never import `ee/(ee)` |
| D-PROVIDERS | Custom OpenAI-compatible / OpenCode | New connections package behind Keychain/catalog | Defer |
| D-BOX-ACL | Box none/use/manage grants | Extend W2/B2 with server authority | Keep single-owner Boxes |

---

## Suggested future agent slice map (after A–H activation)

These are **recommendations for root**, not claims of assignment:

1. **External MCP catalog completion** (post-bridge) — remainder of C matrix  
2. **B5 contextual parity** — P2.1  
3. **C8 residual presentations** — P2.2  
4. **E7 guest install** — P2.4  
5. **W3 delete/rollback** — P2.5  
6. **Custom providers** — only if D-PROVIDERS approved  
7. **Voice STT productization** — P1.2 if provider chosen  

---

## A–H unfinished coverage checklist (must not be “lost”)

- [ ] A binders/route/grant/migration  
- [ ] B runtime authority + routes + barrel  
- [ ] C engine↔UI bridge + remaining tool families  
- [ ] D mount + journal schema + native QA  
- [ ] E/F share routes + picker bridge + native QA  
- [ ] G/H decision → IPC/mount → native QA (no live pairing during agents)  
- [ ] C35 live intake completion QA  
- [ ] Preserve legacy workspace 1 paths/keys during any further W1 work  
