# RD42 root verification matrix (for root — not executed here)

**Purpose:** checklist for root’s integrated release-candidate / Mac acceptance work.  
**This agent did not create fixtures, run the app, grant permissions, or mark results.**  
**Tip referenced:** `406cb2661544e6d6828c36a6c4f8732d2281b3b7` · base `6f6ad959a09abaf1947950b6f82413c94407e22a` · original pin `2a57fa6dd53311f763bfc9abde85997b7f7e5309`

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
