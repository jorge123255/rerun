# Round 38 master inventory (source-only)

Base inspected: `6f6ad959a09abaf1947950b6f82413c94407e22a` on `desktop/round38-master-completion` (clean at inventory start).  
Original comparison pin: `2a57fa6dd53311f763bfc9abde85997b7f7e5309` in read-only `upstream-review-20261106`. Historical pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` remains secondary.  
**Static source/evidence review only. No checks executed. No installed acceptance. Canonical checklist counts are not modified.**

## Remote-base evidence

- Exact approved base `6f6ad959a09abaf1947950b6f82413c94407e22a` is published as `github.com/jorge123255/rerun` branch `desktop/rd38-cloud-base` (parent-verified). Base push approval does **not** approve new source publication.
- Local worktree branch `desktop/round38-master-completion` still has **no upstream**; local heads `desktop/round38-master-completion` and `desktop/m1` resolve to the same SHA.
- Earlier local remote-tracking refs for `origin/{HEAD,main,macos-desktop}` pointed at historical `a6d63a4…` only; do not treat those as the Round38 base.

## RD37 ownership — do not duplicate

| Lane | Tip (clean) | Owns (do not reimplement) |
|---|---|---|
| A custom provider runtime | `9f6893da8c4d2180787833fd20989304a939c7c1` | OpenAI-compatible custom provider runtime |
| B custom provider UI | `f816616020cf4ce68d7001fa2247de28c3f7c8ab` | Settings/model UI for custom providers |
| C OpenCode runtime | `440d9b283aae1ed362eca3daab4aa05493ceaaef` | OpenCode Go/Console runtime |
| D OpenCode UI | `dbecf4b398d844e158d9eeb3281d45e30d7b75d1` | OpenCode connection/models/limits UI |
| E company profile runtime | `5d16ee6d625896735d7210715da786544d85a4e1` | Optional company inference/profile runtime |
| F company profile UI | `4342cde078f6ac01c633e5d4c368b0b307d14c69` | Inferred-profile presentation / intake board preview |
| G chat interactions | `66ea16bf66d3202558f16a44833c8077f0d7cf21` | Question/quick-reply/voice transcript interactions |
| H chat recovery | `f0e1425743e86811109592ecca17c5031b5ed82d` | Missing-conversation / provider-failure recovery |
| I runtime compatibility | `32963bb5867df40a4c098126b1d47c3e0d9bb7fb` | Turn-order / MCP relay / tool-repair / Codex patch fragment |

RD37 tips are **source handoffs awaiting root review**; they are not integrated into this Round38 base and are not Mac acceptance.

## Round38 package allocation status

| Package | Status | Owner |
|---|---|---|
| Inventory | delivered | master agent (this worktree) |
| **RD38 A** portable memories | delivered (`cb7a184d…`) | master agent |
| **RD38 B** portable database | delivered (`1e1b6ea1…`) | master agent |
| **RD38 C** control-center parity | **RESERVED** for isolated agent | seven-agent wave (parent) |
| **RD38 D** run presentations | **RESERVED** for isolated agent | seven-agent wave |
| **RD38 E** share UI for A/B | **RESERVED** for isolated agent | seven-agent wave — consume A/B seam `abe-1` |
| **RD38 F** named API connections runtime | **RESERVED** for isolated agent | seven-agent wave |
| **RD38 G** named API connections UI | **RESERVED** for isolated agent | seven-agent wave (depends F) |
| **RD38 H** startup/packaging readiness | **RESERVED** for isolated agent | seven-agent wave |
| **RD38 I** remote gateway transitions | **RESERVED** for isolated agent | seven-agent wave |

Master agent must **not** implement C–I. Isolated trees are prepared from base `6f6ad959…` with no concurrent master edits, no publication, no checks. Existing `apps/ui/**/control-center-parity` remains for the C agent only.

## Four-state inventory

States: **implemented** (source present in this base), **missing-code** (concrete source gap), **root-verify/config** (source largely present; needs root checks or configured service), **product-decision** (hosting/account/remote/mobile).

### Checklist groups (C5 cross-ref C6 — not a second secure-request package)

| Group | State | Exact Mac / original refs | Notes |
|---|---|---|---|
| B5 Control Center | missing-code + root-verify | Mac: `apps/ui/components/desktop/DesktopControlCenter*`; original `apps/ui/components/control-center/ControlCenter.tsx` | Many commands accepted; remaining contextual actions → RD38 C / RD41 |
| C3 attachments | root-verify | Composer/upload routes + cards | Drop/paste/progress native acceptance outstanding |
| C4 voice/mentions | root-verify + RD37 G | Voice composer + G handoff | Configured STT + rename/delete verify; reuse RD37 transcript |
| C5 interactive requests | cross-ref C6 | Question/approval already installed | **Not a separate implementation count** |
| C6 secure/sign-in/takeover | root-verify | Secret/MCP/takeover cards | Real credential-backed lifecycle pending |
| C7 Actions/notifications | root-verify | Inbox + notification prefs | OS banner/click unobserved |
| C8 run presentations | missing-code + root-verify | Tool/result cards | Residuals → RD38 D / RD39 |
| D4 semantic memories | root-verify/config | `apps/engine/src/desktop/semantic-memory/*`, `memory-store.ts`; original `apps/engine/src/memory/store.ts` | Embeddings unconfigured |
| E2 writeback/search | root-verify + RD36 shared mutations | filesystem/web tools | Provider live acceptance |
| E3 browser/computer | root-verify | browser/computer tools | Custom timeout / non-Latin clipboard unrecorded |
| E4 catalog apps | root-verify/config | services hub | OAuth/SSE/additional-account live gates |
| E5 custom MCP | root-verify/config | mcp-pool + panel | Live SSE/OAuth |
| E7 self-improvement/install | root-verify | self/install tools | Guest package lifecycle |
| E9 webhooks | implemented local; product-decision external | triggers routes | External hosting → RD44 |
| E11 Foreman | root-verify + RD37 E/F | Foreman tools/UI + company profile lanes | Auto inference / richer profile via RD37 compose |
| W3 templates | root-verify | portable templates + share privacy fixes on base | Delete/rollback/cleanup native |
| D3 Claude subscription | root-verify | Claude plan steps | User sign-in pending |
| D9 sharing/publication | missing-code local memories/db; product-decision hosted | Mac: `apps/engine/src/desktop/coworker-share/*`, `apps/ui/lib/desktop/server/coworker-share/*`, `components/desktop/coworker-share/*`; original `apps/ui/components/agent/share/*`, `packages/contracts/src/agent-share.ts` | Offline share UI/runtime present; **memories+database marked unavailable** in `binding.ts`; hosted links → RD44 |
| W1 workspaces/machines | implemented local; missing-code remote | workspaces + RD36 machine handoffs | Remote → RD38 I / RD43 |
| W2 collaboration | product-decision | members/account dialogs | Needs multi-user authority |
| W4 external client | root-verify + RD36 | external MCP catalog | Scoped lifecycle; listener default-off |

### Named/API-provider / upstream deltas (separate from historical 21)

| Item | State | Refs |
|---|---|---|
| Multiple named API-provider connections | missing-code | Original `AddProviderPage.tsx`, `AiProvidersPanel.tsx`, `ConnectionDetail.tsx`, `DeleteConnectionButton.tsx`; Mac settings update first connection only → RD38 F/G |
| RD37 custom/OpenCode/company/chat | implemented in RD37 worktrees; not in this base | See RD37 table — root compose only |
| Mobile companion | product-decision | `apps/mobile/*` at `2a57fa6` → RD45 |
| Box ACL none/use/manage multi-user | product-decision | → RD44 |

### D9 memories/database detail (RD38 A/B/E)

| Piece | State | Path |
|---|---|---|
| Share include schema memories/database/files | implemented | `packages/contracts/src/desktop-coworker-share.ts` |
| Options UI labels Memories / Coworker database / Workspace files | implemented | `apps/ui/components/desktop/coworker-share/DesktopCoworkerShareOptions.tsx`; original `ShareAgentOptions.tsx` |
| Snapshot member filter for `memory/` when include.memories | implemented (codec only) | `apps/engine/src/desktop/coworker-share/snapshot.ts` |
| Production source capture of canonical notes | **missing-code** | `readCurrentDesktopCoworkerShareSource` uses template inspector; `inspect.ts` excludes `memory`; binding sets `unavailable.memories` |
| Canonical note restore / fresh-destination install | **missing-code** | Install rejects non-template paths; no dedicated memory restorer |
| Private DB export/restore | **missing-code** | Same unavailable.database; → RD38 B |
| Share preview/import UI binding real A/B ports | partial UI; **missing-code** wiring | → RD38 E after A/B |

## Roadmap master phase packages (canonical seams)

Seams root must compose (do not invent second authorities): existing `desktop-coworker-share` service/store/binding; canonical `memory-store` / `listDesktopMemory` / `indexMemory`; portable template installer for non-memory members; RD37 published provider/chat ports; RD36 remote-machine supervisor (I); aggregate contracts barrel + migration ladder (root-only).

| Package | Goal | Depends |
|---|---|---|
| **RD38 A** | Portable coworker memories capture/restore ports | Canonical memory list/install authority |
| **RD38 B** | Portable private coworker database | A/B/E transfer field contract; private data authority |
| **RD38 C** | Remaining Control Center local actions | Existing command catalog |
| **RD38 D** | Remaining run/tool presentations | RD37 G/H interfaces only |
| **RD38 E** | Share preview/import UI for A/B | A+B ports |
| **RD38 F** | Named API connection runtime | Preserve Codex/Claude + RD37 custom/OpenCode |
| **RD38 G** | Named API connection UI | F |
| **RD38 H** | Startup/packaging/privacy readiness source | Stable signer; no cert changes |
| **RD38 I** | Remote gateway transitions (optional local milestone) | RD36 machine source; no live pair |
| RD39 | Journey defect closeout | Existing features |
| RD40 | Providers/recall/Foreman compose | RD37 + F |
| RD41 | Design/state audit | All |
| RD42 | RC repair handoff | All local |
| RD43–45 | Remote/hosted/mobile | Product decisions |

## Critical issue notice

No critical blocker found that prevents RD38 A. Memories remain correctly fail-closed (`unavailable.memories`) until A ports bind; do not enable the checkbox alone. Cloud base branch `desktop/rd38-cloud-base` holds the exact SHA. C/F cloud reservations were released after F’s automatic PR workflow was canceled; no independent cloud package is active. New code publication remains unapproved.

## RD40 / RD41 / W4 note (master)

- **W4 external MCP grant bypass:** source repaired on this branch at `73b6855e6d227011fcd6198ce3ee71f1d640a94c` (operations adapter deny only). Details: `docs/desktop-round40-w4-grant-guard-handoff.md`. Not accepted / not tested.
- RD39/40/41 cloud audits reconciled into `docs/desktop-round42-*.md`. Implementation of unrepaired candidates is **not** claimed complete. C–I still RESERVED.
- Same-box Duplicate currently inherits config grants; portable import forces grants off. User t18u no-inherited-grants on copies/imports recorded as root discrepancy (not overridden by audit product-decision label).

## RD39 E3/C3 source repairs (master)

- E3 paste: `d7dc1685e2b2648c7a61c29ade8fa8a7b95992d0` — `docs/desktop-round39-paste-handoff.md` (SOURCE-REPAIRED; ROOT-UNVERIFIED guest).
- C3 document add: `2520a0ef3d483bd29c66e12fdb4ebfd37761a4bb` — `docs/desktop-round39-document-attachments-handoff.md` (SOURCE-REPAIRED hook; INTEGRATION-PENDING conversation >14/await).
- C7: do not remove native notification channel.

