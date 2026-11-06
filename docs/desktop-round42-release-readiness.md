# RD42 source-only release readiness notes (preparation)

**Not a distribution, store, or notarization claim.** No version bump, signing, update-feed, or publication action is authorized here.  
**Referenced tip:** `4415d3193bc467d0f25cbd9fdfdb3d76bf5c65f8` · base `6f6ad959a09abaf1947950b6f82413c94407e22a`

## Supported local features (source present on this branch / prior accepted slices)

- Local workspace identity, board/chat tabs, Codex path, files/skills/routines/templates slices as previously recorded in the canonical checklist (root acceptance may still be in progress for some).
- **New on this branch (source, unbound in product UI):** portable memory transfer ports (A) and logical private-database transfer ports (B), fail-closed until root binds authorities.

## Precise unavailable / gated items

| Item | Why unavailable in product now |
|---|---|
| Share → Memories | `unavailable.memories` until A capture+install bound + barrel export |
| Share → Coworker database | `unavailable.database` until B reader/writers bound + barrel export |
| Hosted share links / public URLs | RD44 product decision — offline portable ≠ public link |
| External webhook hosting | RD44 — loopback local slice ≠ public hosting |
| Remote machine Connected | RD38 I + RD43 — no automatic pairing; never Connected on metadata alone |
| Collaboration accounts/roles/Box ACLs | RD44 — ChatGPT login is not a workspace account system |
| Mobile companion | RD45 |
| Public Mac distribution / notarization changes | RD45 + separate root release action |
| RD38 C–I feature packages | PENDING — user t31u short tips C`80cdcab4` F`72e8ef86` H`62c7a5d8` I`a9fa3888`; D/E no local delta; G WIP; **not merged/complete** |
| RD39–41 audits/implementation | Audits reconciled into RD42 docs; **implementation incomplete** (W4 source repair only) |

## Honest defaults to preserve

- Model/reasoning defaults, drafts, board placement, workspace identity, Markdown, skill ownership, migration identities.
- Imports create fresh identities: no inherited chats, credentials, connections, or grants.
- Privacy: `.rerun*` and `.rerun-skill-*` never enter portable capture/preview/archive/install (including nested/aliases); ordinary hidden user assets remain supported.
- Stable signer `21C5B4D06CE5EDF47143C1327B72D76E478A065D` and canonical app path — no cert/entitlement changes in this preparation.

## RD43–45 decision gates (plan only — not implemented)

1. **RD43:** Approved compatible remote host + explicit user activation before pair/replace/remove acceptance.
2. **RD44:** Conditional plan sourced (`01M6S8847DX06HMEYQVV73EZYP.md`). Hosted links/public webhooks/multi-user ACL remain unmade host/account decisions; local milestone independent. Desktop-base `/p/[slug]` older unguarded redirect **must not** be enabled as shortcut vs pin gate+signed read. Loopback auth/replay/rotate stays; disabled networking stays off. No vendor/host selected.
3. **RD45:** Conditional plan sourced (`01M6S85MF39SNP545DE226RXTS.md`). Pin phone = Expo/Supabase hub client (bearer+`x-workspace-id`), absent on `6f6ad959`. No phone↔Mac pairing contract; `/api/engines/pair` and remote-machine allowlist are not phone protocol. User/root: hub deployment vs new phone-to-Mac protocol. Distribution preview path/id/versions unchanged; signer pin user-provided not repo evidence. Do not port/activate.

## Misleading claims

Owned A/B docs/source reviewed: no fake Connected/PASS success claims found; no code repair in this checkpoint. Root should continue scrubbing any integrated UI copy that implies live Connected/hosted success without authority.

## RD39 audit intake (not acceptance)

Frozen-base audit `bc-1e95582a-a658-55d3-8480-85f654b18cc8` reconciled. **SOURCE-REPAIRED:** E3 paste (`d7dc1685e2b2648c7a61c29ade8fa8a7b95992d0`), C3 document add (`2520a0ef3d483bd29c66e12fdb4ebfd37761a4bb`). **INTEGRATION-PENDING:** >14 + await docs in conversation. **ROOT-UNVERIFIED:** guest paste + C7 receipt (**keep native channel**). C–I still PENDING.

## RD40 / RD41 audit intake (not acceptance)

- **RD40:** **W4** `73b6855e…`; **D4** `d0b2a798…`; **D3** `4415d319…`; **E2 nontext** `42aa785f9b72ca676bc473cab0f708f899db0d3f` (handoff `docs/desktop-round40-nontext-writeback-handoff.md`); **E2 search** `aed685747b0ee88fad99e90bf870650be997d990` (handoff `docs/desktop-round40-search-revision-handoff.md`) — all SOURCE-REPAIRED / **not tested / not accepted**. **Do not mark whole RD40 accepted.** C–I / root conversation+notifications still pending.
- **RD41:** Three confirmed unrepaired defects (share plan credential count/label; board camera persistence; five loading skeletons — no UI edits here). Same-box Duplicate **inherits grants today**; portable import forces grants off. **t31u:** grant/credential inheritance is a SOURCE/SPEC discrepancy for root — do not settle from outside-task quotes; do not change clone semantics here; preserve import restrictions. Root separately decides `.env`/`mcp`/credential **file** copy semantics. Preserve `.rerun*` / `.rerun-skill-*` exclusion and ordinary hidden files.
- **t31u UP packets (docs):** see `docs/desktop-round42-upstream-pr38-supplement.md` — UP-01…07 mapped into E8/E10/E4/E2/C3/D7/C7 under existing RD39/40/42 numbering; upstream `ab3def9b…` supplement-only; **not** RD46; **not** implemented this checkpoint.
- **W4 root queue:** integrate `73b6855e…` before external write enable; inspect remaining Mac catalog projection advertising refused `tools`/`selfImprovement` (distinct from already-delivered adapter catalog honesty).
- **RD39** four defects still unrepaired; C7 native notify channel decision preserved.
- All cloud audits (RD39/40/41) returned; **none** of RD39/40/41 are implementation-complete. C–I still PENDING.

## t31u upstream supplement (docs-only)

Canonical table: `docs/desktop-round42-upstream-pr38-supplement.md`. Seven UP packets attach to existing groups. Nine delivered packets remain integration/root-check only. No feature code in this checkpoint. No installed/live acceptance.
