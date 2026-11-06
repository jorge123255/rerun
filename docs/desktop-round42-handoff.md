# RD42 preparation handoff

**Kind:** RD42 preparation + RD39/RD40/RD41 audit reconciliation + **RD40 W4 narrow source repair** — **not** RD39/40/41/42 completion.  
**Base:** `6f6ad959a09abaf1947950b6f82413c94407e22a`  
**Original pin:** `2a57fa6dd53311f763bfc9abde85997b7f7e5309`  
**W4 impl SHA:** `73b6855e6d227011fcd6198ce3ee71f1d640a94c`  
**Parent tip before W4 impl:** `92dc02509cd9a3069bb588b39da6f3e6f6184bba`  
**Branch:** `desktop/round38-master-completion`  
**No checks executed. No installed acceptance. No push/PR. Canonical checklist not mutated.**

## Deliverables

| Doc | Role |
|---|---|
| `docs/desktop-round42-source-inventory.md` | A/B + RD39 four defects + RD40 five candidates (W4 repaired) + RD41 three defects + Duplicate-grants discrepancy |
| `docs/desktop-round42-root-verification-matrix.md` | Local/A/B + RD39 R1–R4 + RD40 F + RD41 G |
| `docs/desktop-round42-release-readiness.md` | Supported/unavailable + audit intake |
| `docs/desktop-round40-w4-grant-guard-handoff.md` | Exact W4 impl SHA, paths, denied fields, unrun regressions, limits |
| `docs/desktop-round42-handoff.md` | This file |

## Status snapshot

| Track | Status |
|---|---|
| RD38 A/B | Source delivered; product binding still `unavailable.*` |
| RD38 C–I | **PENDING** seven-agent exclusive trees |
| RD39 | Audit reconciled; **4 defects unrepaired** |
| RD40 | Audit reconciled; **W4 source repaired** (`73b6855e…`); **4 candidates unrepaired**; not accepted/tested |
| RD41 | Audit reconciled; **3 defects unrepaired** + Duplicate grants discrepancy vs t18u; no runtime edits |
| RD42 | Preparation / inventory only — **not** RC complete |

## RD39 outcome (unchanged)

| ID | Action |
|---|---|
| D1 E3 Paste | Root/E3 — route non-Latin via `type()` |
| D2 C3 >14 | Root/C3 — remove hard cap |
| D3 C3 docs batch | Root/C3 — per-file + await batch |
| D4 C7 receipt | **Keep native channel**; status from native result |

## RD40 outcome

| # | Action |
|---|---|
| 1 W4 grants | **Repaired source** in `external-mcp-tools/operations.ts` only — see W4 handoff |
| 2–5 | Docs-only proposed fragments; owners D3/E2/D4 |

## RD41 outcome

| ID | Action |
|---|---|
| D1 share plan | Root canonical `snapshot.ts` — align count/reason with `includeMember`; E consumes plan |
| D2 board camera | Root `DesktopBoard` — workspace-scoped persist |
| D3 skeletons | Panel owners later — **no UI edit this pass** |
| Duplicate grants | **Discrepancy:** Duplicate inherits grants; t18u requires no inherited grants on copies/imports. Root decides env/mcp **file** copy separately; must not treat audit “product decision” as override |

## Diff this checkpoint

- Impl: W4 grant-guard (`73b6855e…`) — adapter + catalog honesty + unrun tests only.
- Docs: W4 handoff + RD42 inventory/matrix/readiness/handoff + master inventory/manifest updates.
- No engine routes, no C–I, no F named connections, no RD37 UI, no duplicate/secret/env runtime edits, no checklist marking.

## Checks NOT run

tests, typecheck, lint, build, install, fixtures, app, provider, Docker, UI, Keychain, restart, live data, listeners.

## Next

Root/owners apply unrepaired defects; fill matrix cells; bind A/B; wait is over for cloud audits (all returned) but C–I source packages remain PENDING before claiming RD42 RC.
