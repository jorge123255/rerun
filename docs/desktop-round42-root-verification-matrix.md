# RD42 root verification matrix (for root — not executed here)

**Purpose:** checklist for root’s integrated release-candidate / Mac acceptance work.  
**This agent did not create fixtures, run the app, grant permissions, or mark results.**  
**Tip referenced:** `4415d3193bc467d0f25cbd9fdfdb3d76bf5c65f8` (RD40 D3 Claude generation + prior)

Result cells stay blank until root fills them. Distinguish: source present ≠ root accepted ≠ configured service live.

## A. Local Mac readiness

| ID | Expected user outcome | Disposable QA fixture (definition only) | Temp permissions / config / consent | Failure evidence to capture | Cleanup | Preserve user state | Root result |
|---|---|---|---|---|---|---|---|
| L1 | App starts with stable signed identity | Fresh QA profile separate from personal data | none beyond normal launch | crash log / wrong bundle id | quit app | personal profile untouched | |
| L2 | Prior coworkers/chats/files still present after upgrade | Copy of disposable workspace | n/a | missing coworker / empty board | discard copy | production data untouched | |
| L3 | Board + side-panel chat + tabs coexist | QA board with ≥2 coworkers, 2 tabs | n/a | panel replace / lost tab | close QA workspace | camera/drafts of personal WS | |
| L4 | Selected model returns a real reply | One Codex-connected QA coworker | user consent for provider spend | stub/empty/error mislabeled success | stop run | personal chats | |
| L5 | Stop cancels in-flight work honestly | Long-running QA prompt | n/a | continued tokens after Stop | n/a | drafts | |
| L6 | Errors/approvals show truthful states | Forced error + pending approval | n/a | fake Done / missing card | resolve/decline | unrelated drafts | |
| L7 | Files/memory/tools respect coworker isolation | Two QA coworkers with distinct notes/files | grants default off except under test | cross-read | revoke grants | other coworkers | |
| L8 | Provider/settings survive restart | Toggle one QA setting | n/a | reset to default | restore prior | personal settings | |
| L9 | Full quit + relaunch restores board/chat/draft | Unsent draft + open tab | n/a | lost draft/tab | n/a | personal drafts | |

## B. Offline portable share — Memories (A) once root-bound

| ID | Expected user outcome | Disposable QA fixture | Temp permissions / config | Failure evidence | Cleanup | Preserve | Root result |
|---|---|---|---|---|---|---|---|
| S1 | Preview shows exact note count/bytes/digest | QA coworker with 2 canonical notes | A ports bound; Memories enabled only if available | wrong count / null digest while available | delete QA copy | source notes unchanged | |
| S2 | Review binds include.memories to that digest | Same | n/a | stale digest accepted | n/a | source | |
| S3 | Export excludes chats/providers/embeddings/system.db/.rerun* | Notes + decoy embedding/index paths | n/a | leaked path/secret in archive | delete archive | source | |
| S4 | Import into **fresh** coworker only | Empty destination coworker | n/a | wrote into source / non-empty dest | delete destination | source | |
| S5 | Retry/lost-ACK reuses identities; no duplicate notes | Interrupt after first note | n/a | duplicate ids | clear dest | source | |
| S6 | Partial/unavailable stays explicit | Unbind install writer | n/a | UI shows success | restore unavailable copy | n/a | |

## C. Offline portable share — Coworker database (B) once root-bound

| ID | Expected user outcome | Disposable QA fixture | Temp permissions / config | Failure evidence | Cleanup | Preserve | Root result |
|---|---|---|---|---|---|---|---|
| D1 | Preview table count/bytes/viewCount/digest | Private table + saved view | B ports bound | raw sqlite advertised as success | n/a | source DB | |
| D2 | Package has logical tables/views only (no agent.db bytes / no SQL text) | Table with TEXT/INTEGER rows + view | n/a | archive contains `.db` or `DROP`/`ATTACH` | delete archive | source | |
| D3 | Shared.db / system tables never included | Shared table exists in workspace | private reader only | shared rows in package | n/a | shared DB | |
| D4 | Fresh destination only; parameterized restore | Empty private DB dest | n/a | mutated source / non-fresh dest | drop dest coworker | source | |
| D5 | Partial disk failure → partial/uncertain, not full success | Force writer failure on 2nd table | n/a | status=installed with missing table | delete dest | source | |
| D6 | Duplicate import retry reuses table/view recovery keys | Re-run same captureRequestId | n/a | duplicate tables | clear dest | source | |

## D. Configuration / product decisions (not source bugs)

| ID | Gate | Notes | Root result |
|---|---|---|---|
| P1 | Embeddings / STT / OAuth / SSE live | Source may exist; live acceptance separate | |
| P2 | Hosted share URL / external webhooks / multi-user ACL | RD44 — needs authority | |
| P3 | Remote machine pair | RD43 — needs approved host | |
| P4 | Mobile / public notarized distribution | RD45 | |

## C5 → C6

Interactive secure secret/sign-in/takeover verification is **C6** only. Do not double-count C5 as a separate secure-request package.

## E. RD39 journey defects (root verifies after surgical source repair)

Audit base `6f6ad959a09abaf1947950b6f82413c94407e22a`; symbols re-confirmed on master `3ecdd20c1889df01109c73864a325c9fe5ea1d2c`. Result cells blank until root runs.

| ID | Journey | Expected user outcome after repair | Disposable fixture (define only) | Temp perms/config | Failure evidence | Cleanup | Preserve | Root result |
|---|---|---|---|---|---|---|---|---|
| R1 | E3 Paste | Non-Latin paste matches typed characters; Latin-1 still clipboard+Ctrl+V; extended clipboard not negotiated | Guest browser field + terminal; strings `café`, `こんにちは`, `Hello`, astral | Docker/guest image; computer grant on disposable coworker | Wrong glyphs / disconnect from extended clipboard | Stop guest; revoke grant | Host clipboard; sibling screens | SOURCE-REPAIRED `d7dc1685e2b2648c7a61c29ade8fa8a7b95992d0` — ROOT-UNVERIFIED |
| R2 | C3 >14 | Files that fit attach; overflow named; order kept | 10 txt + 4 png; +1 txt; 15 txt; mix+PDF | Local desktop app | Empty attach set despite legal files | Delete disposable Files rows | Other drafts | |
| R3 | C3 docs | Valid PDF kept when neighbor empty/oversize; batch status includes document outcome | `note.md`, `ok.pdf`, `empty.pdf`, `photo.png` | n/a | “Nothing was attached” after text/image committed; missing ok.pdf | Delete doc rows | Tab-scoped only | Hook SOURCE-REPAIRED `2520a0ef3d483bd29c66e12fdb4ebfd37761a4bb`; conversation INTEGRATION-PENDING |
| R4 | C7 receipt | Native `failed`/`unknown` does **not** durable-mark `shown`; retry/cooldown can run; toast may still show; Open click still resolves | Disposable question event; force native fail/timeout if possible | In-app toasts on; **do not** request new OS permission | Seen row inserted despite failed native | Delete disposable coworker | Real inbox receipts | |

**C7 note for root:** Prefer receipt-truthfulness with native channel retained (t18u). Do not remove `bridge.notify` solely to make toast-only receipts look consistent.

## F. RD40 candidates (root verifies; W4 source repaired only)

Audit asset `01M6S6Z5RSZHQX92H233BR0AH0.md`; verified on master before/after W4. Result cells blank until root runs. **Not acceptance.**

| ID | Journey | Expected after repair | Disposable fixture | Temp perms | Failure evidence | Cleanup | Preserve | Root result |
|---|---|---|---|---|---|---|---|---|
| W4-G1 | External grant bypass | `coworkers:write` `update_agent` with tools/grants/selfImprovement returns unsupported; grants stay default-off after restart; metadata-only update still works | Disposable coworker + key (`mcp:read`+`coworkers:write`); listener QA-only | Grants off; listener off after | Grants flipped / partial apply / sibling changed | Revoke key; delete coworker; disable listener | Default model; other keys | |
| D3-R1 | Claude re-login truthfulness | Cancel/fail replacement keeps prior generation `connected`; chat still uses that token; disconnect removes token | Fixture encrypted env token (no live account required for this row) | Desktop app flag | Snapshot shows signed-out while token live | Disconnect; delete fixture env | Other connections | SOURCE-REPAIRED `4415d3193bc467d0f25cbd9fdfdb3d76bf5c65f8` — ROOT-UNVERIFIED |
| E2-N1 | Native nontext receipt | Shell `note.md` + `blob.bin` → markdown pending + bin unsupported; approve md only; bin absent after restart | Coworker with native write grant | n/a | Bin missing from review / bytes in workspace | Delete QA files | Sibling coworker | |
| D4-V1 | Clear-all vector wipe | After clear, A index has no records before success receipt; B untouched; wipe failure surfaces | Two coworkers; optional fixture embedder | No OpenRouter unless consented | Vector residue for cleared notes / silent success | Clear A; confirm wipe | B notes; Brain | SOURCE-REPAIRED `d0b2a79834261ad34e04abd4e9ce20e1f79cdc16` — ROOT-UNVERIFIED |
| E2-S1 | Search key rotation receipt | Mid-flight revision bump → “Search capability changed.” / uncertain as specified; body not published; next call can succeed | Fixture Brave-shaped server | webSearch grant | Generic “provider failed” replay forever | Delete outcome row + key | Other auxiliary | |

## G. RD41 candidates (root / panel owners — no master UI edits this pass)

Audit asset `01M6S74CTXEGPS2M7G67ZPH2VM.md`; verified on master `73b6855e…`. **Not acceptance.**

| ID | Defect | Expected after repair | Fixture | Notes | Root result |
|---|---|---|---|---|---|
| S-P1 | Share plan count/label | Credential paths not in files count; exclusion reason `credentials`; `.notes.md` still counted; `.rerun*` uncounted | Coworker Files with `.env`, key file, `.notes.md`, `.rerun-backup-old` | Canonical `snapshot.ts` only; E consumes plan | |
| B-C1 | Board camera persist | Pan/zoom survive chat, quit/reopen, workspace switch; Recenter then new pan stored | Two QA workspaces | Root `DesktopBoard` / workspace-scoped store | |
| UI-L1 | Five loading skeletons | Unresolved Files/Memories/Settings/Schedules/Tools show matching skeletons not sentences | Each panel unresolved → empty → error | Panel owners / seven-agent; not this master commit | |
| DUP-G1 | Duplicate grants | **User requirement:** copy/import must not inherit grants. After root decision, Duplicate must not leave tool grants on. Credential/`.env`/`mcp/` copy policy is a **separate** root product choice | Disposable coworker with grants on → Duplicate | Do **not** treat audit “product decision” as override of no-grant inheritance | |

**Privacy preserve:** `.rerun*` / `.rerun-skill-*` nested aliases excluded; ordinary hidden user files remain portable-eligible.

