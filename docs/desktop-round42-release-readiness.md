# RD42 source-only release readiness notes (preparation)

**Not a distribution, store, or notarization claim.** No version bump, signing, update-feed, or publication action is authorized here.  
**Referenced tip:** `73b6855e6d227011fcd6198ce3ee71f1d640a94c` · base `6f6ad959a09abaf1947950b6f82413c94407e22a`

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
| RD38 C–I feature packages | PENDING isolated agents |
| RD39–41 audits/implementation | Audits reconciled into RD42 docs; **implementation incomplete** (W4 source repair only) |

## Honest defaults to preserve

- Model/reasoning defaults, drafts, board placement, workspace identity, Markdown, skill ownership, migration identities.
- Imports create fresh identities: no inherited chats, credentials, connections, or grants.
- Privacy: `.rerun*` and `.rerun-skill-*` never enter portable capture/preview/archive/install (including nested/aliases); ordinary hidden user assets remain supported.
- Stable signer `21C5B4D06CE5EDF47143C1327B72D76E478A065D` and canonical app path — no cert/entitlement changes in this preparation.

## RD43–45 decision gates (plan only — not implemented)

1. **RD43:** Approved compatible remote host + explicit user activation before pair/replace/remove acceptance.
2. **RD44:** Real storage/auth for hosted links; authenticated public webhooks; multi-user authority for W2/ACLs — do not simulate with localhost-as-public or EE imports.
3. **RD45:** Specify phone↔Mac contract, pairing/revocation, credential storage, offline behavior before transport port; separate signing/notarization/update plan for public Mac delivery.

## Misleading claims

Owned A/B docs/source reviewed: no fake Connected/PASS success claims found; no code repair in this checkpoint. Root should continue scrubbing any integrated UI copy that implies live Connected/hosted success without authority.

## RD39 audit intake (not acceptance)

Frozen-base audit `bc-1e95582a-a658-55d3-8480-85f654b18cc8` reconciled. Four confirmed source defects remain open for root/owner repair (E3 paste, C3 >14, C3 document batch, C7 native receipt). **Do not treat audit text as PASS or as permission to disable native notifications.** Live OAuth/STT/Docker/native banner observation remain configuration/root gates. C–I and RD40–41 still PENDING.

## RD40 / RD41 audit intake (not acceptance)

- **RD40:** Five candidates. **W4 grant-bypass:** source repaired at `73b6855e…` (external operations adapter only; unrun regressions authored; **not tested / not accepted**). Candidates 2–5 (Claude relogin truthfulness, native nontext receipt, clear-all vector residue, search rotated-key classification) remain open for owners. Handoff: `docs/desktop-round40-w4-grant-guard-handoff.md`.
- **RD41:** Three confirmed unrepaired defects (share plan credential count/label; board camera persistence; five loading skeletons — no UI edits here). Same-box Duplicate **inherits grants today**; portable import forces grants off. **User t18u forbids inherited grants on copies/imports** — recorded as discrepancy for root authority, not accepted as settled product decision. Root separately decides `.env`/`mcp`/credential **file** copy semantics. Preserve `.rerun*` / `.rerun-skill-*` exclusion and ordinary hidden files.
- **RD39** four defects still unrepaired; C7 native notify channel decision preserved.
- All cloud audits (RD39/40/41) returned; **none** of RD39/40/41 are implementation-complete. C–I still PENDING.

