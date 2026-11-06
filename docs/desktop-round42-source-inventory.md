# RD42 source inventory (preparation — not complete)

**Status:** independent RD42 preparation checkpoint only. Does **not** claim release-candidate completion, Mac acceptance, or that RD39–41 / C–I are done.  
**Worktree tip at inventory authorship:** `70e03e69d7515b122d56eb399699501b9cbdde85` on `desktop/round38-master-completion` (RD40 E2 nontext+search SOURCE-REPAIRED; docs tip this commit)
**Prepared base:** `6f6ad959a09abaf1947950b6f82413c94407e22a` (`desktop/rd38-cloud-base`)  
**Original comparison pin:** `2a57fa6dd53311f763bfc9abde85997b7f7e5309` (historical `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` secondary)  
**Seam:** A/B/E `abe-1` in `docs/desktop-round38-a-transfer-seam.md`  
**Checks:** none executed by this agent.

## Commit order on this master branch (exact)

| Order | SHA | Package |
|---|---|---|
| 0 | `6f6ad959a09abaf1947950b6f82413c94407e22a` | Prepared Round38 base (portable-share metadata fixes) |
| 1 | `3c6f70a60bb8de49ba489ff0bf1670bfcf17ecc7` | Master inventory + commit manifest |
| 2 | `cb7a184d918e45899574c37232c43dba1261bd44` | **RD38 A** portable coworker memories implementation |
| 3 | `ed7c737629adfe5b02555c5d061d83dec158221a` | RD38 A handoff |
| 4 | `1e1b6ea138ff3e0c3051e2607304d0ea33260ec0` | **RD38 B** logical portable coworker database implementation |
| 5 | `406cb2661544e6d6828c36a6c4f8732d2281b3b7` | RD38 B handoff |
| 6 | `3ecdd20c1889df01109c73864a325c9fe5ea1d2c` | RD42 RC preparation docs |
| 7 | `92dc02509cd9a3069bb588b39da6f3e6f6184bba` | RD39 frozen-base reconcile into RD42 |
| 8 | `73b6855e6d227011fcd6198ce3ee71f1d640a94c` | **RD40 W4** external `update_agent` grant-guard (narrow adapter deny) |
| 9 | `ddbcd349017f42665d0760f58721cc23e40940e9` | RD40 W4 handoff + RD40/RD41 → RD42 docs |
| 10 | `d7dc1685e2b2648c7a61c29ade8fa8a7b95992d0` | **RD39 E3** non-Latin guest paste Unicode keysym path |
| 11 | `2520a0ef3d483bd29c66e12fdb4ebfd37761a4bb` | **RD39 C3** per-file document attach outcomes |
| 12 | `47ad3bb11c19cdf3903b3d58815e9a18a888d78e` | RD39 E3/C3 → RD42 docs |
| 13 | `d0b2a79834261ad34e04abd4e9ce20e1f79cdc16` | **RD40 D4** private memory clear → semantic index wipe |
| 14 | `c183cd50993cfeab142278f6389899ceb477f576` | RD40 D4 → RD42 docs |
| 15 | `4415d3193bc467d0f25cbd9fdfdb3d76bf5c65f8` | **RD40 D3** Claude generation / pendingAttempt truthfulness |
| 16 | `c43c532dad511ed1c483d142e2345570418e0c73` | RD40 D3 → RD42 docs |
| 17 | `42aa785f9b72ca676bc473cab0f708f899db0d3f` | **RD40 E2** native non-text unsupported writeback receipt |
| 18 | `81d3109489cabe7397763194f8adad44522d8199` | RD40 E2 nontext handoff |
| 19 | `aed685747b0ee88fad99e90bf870650be997d990` | **RD40 E2** search credential-revision classification |
| 20 | `70e03e69d7515b122d56eb399699501b9cbdde85` | RD40 E2 search revision handoff |

## Delivered on this branch (source only)

### RD38 A — portable coworker memories (`cb7a184d918e45899574c37232c43dba1261bd44`)

| Item | Path / symbol |
|---|---|
| Contract | `packages/contracts/src/desktop-coworker-share-memory.ts` (**not** barrel-exported yet) |
| Module | `apps/engine/src/desktop/coworker-share-memory/` |
| Ports | `previewDesktopCoworkerShareMemory`, `captureDesktopCoworkerShareMemory`, `restoreDesktopCoworkerShareMemory`, capture/install adapters, archive member helpers |
| Unrun regressions | `serialize.test.ts`, `capture-restore.test.ts` |
| Original refs | `packages/contracts/src/agent-share.ts`; `ShareAgentOptions.tsx`; memory frontmatter / `import.ts` reindex behavior |
| Product gate | `unavailable.memories` still set in `apps/ui/lib/desktop/server/coworker-share/binding.ts` |

### RD38 B — logical portable private database (`1e1b6ea138ff3e0c3051e2607304d0ea33260ec0`)

| Item | Path / symbol |
|---|---|
| Contract | `packages/contracts/src/desktop-coworker-share-database.ts` (**not** barrel-exported yet) |
| Module | `apps/engine/src/desktop/coworker-share-database/` |
| Ports | `previewDesktopCoworkerShareDatabase`, `captureDesktopCoworkerShareDatabase`, `restoreDesktopCoworkerShareDatabase`, private reader/install adapters, `logicalCreateTableSql` |
| Unrun regressions | `normalize.test.ts`, `capture-restore.test.ts` |
| Original refs | `agent-share.ts` `data/agent.db` include; `sqlStore.ts`; `tableViews.ts` — **Mac adaptation:** logical schema/rows/views, not raw SQLite bytes |
| Product gate | `unavailable.database` still set in coworker-share `binding.ts` |

## Root activation fragments still required (root-owned)

```ts
// packages/contracts/src/index.ts
export * from './desktop-coworker-share-memory.js'
export * from './desktop-coworker-share-database.js'
```

- Bind A capture list + note install writer; clear `unavailable.memories` only when both succeed.
- Bind B private `agent.db` reader (never shared/system) + fresh-destination table/view writers; clear `unavailable.database` only when both succeed.
- Do not broaden `isTemplateManifestPath` for raw `memory/` dumps or `data/agent.db` / archive SQL.
- Aggregate migrations, routers, DesktopApp/composer mounts, registries remain root-only.

## PENDING — do not mark complete

| Track | State |
|---|---|
| RD38 **C** control-center parity | PENDING — seven-agent isolated tree |
| RD38 **D** run/tool presentations | PENDING — seven-agent isolated tree |
| RD38 **E** share preview/import UI (consumes A/B + `abe-1`) | PENDING — seven-agent isolated tree |
| RD38 **F** named API-connection runtime | PENDING — seven-agent isolated tree |
| RD38 **G** named API-connection UI | PENDING — seven-agent isolated tree (depends F) |
| RD38 **H** packaging/startup readiness source | PENDING — seven-agent isolated tree |
| RD38 **I** remote gateway transitions source | PENDING — seven-agent isolated tree |
| **RD39** local journey audits/fixes | **E3 paste + C3 document add SOURCE-REPAIRED**; D2 >14 + D4 C7 receipt **INTEGRATION/ROOT pending**; not complete / not accepted |
| **RD40** providers/recall/Foreman/W4/D4/D3/E2 | **W4** `73b6855e…`; **D4** `d0b2a798…`; **D3** `4415d319…`; **E2 nontext** `42aa785f9b72…`; **E2 search** `aed685747b0e…` — all SOURCE-REPAIRED / **not accepted / not tested**; C–I + remaining root still open; **RD40 not complete** |
| **RD41** whole-product design/state audit | **audit reconciled** — 3 confirmed defects + Duplicate-grants discrepancy **unrepaired** (root); not complete |
| **RD42** RC repair + root acceptance | **this doc is preparation only** — not finished |
| RD43 remote host acceptance | product/host gate |
| RD44 hosted share/webhooks/collaboration | **conditional plan sourced** (asset `01M6S8847DX06HMEYQVV73EZYP.md`) — product/authority gate; local milestone independent; **not accepted / not implemented** |
| RD45 mobile + public distribution | **conditional plan sourced** (asset `01M6S85MF39SNP545DE226RXTS.md`) — hub vs new phone↔Mac contract decision required; **not accepted / not implemented** |

## Historical checklist discipline

Canonical `docs/desktop-parity-checklist.md` is **not** mutated here. Historical open groups remain as recorded (14 checked / 21 unchecked at prior allocation). **C5 is a cross-reference to C6**, not a second secure-request implementation package. List each group once when reconciling later.

## Fake-success audit (owned A/B)

Static review of A/B modules, contracts, and handoffs found **no** product `Connected` / `PASS` / fake-success claims. Handoffs explicitly state no checks / no installed acceptance. Binding still fail-closes memories/database. **No A/B source repair required in this checkpoint.** Findings outside A/B ownership (if any later) go to root as patch recommendations only.

## RD39 frozen-base audit reconciliation (source review only)

**Audit source:** cloud agent `bc-1e95582a-a658-55d3-8480-85f654b18cc8` report against exact `6f6ad959a09abaf1947950b6f82413c94407e22a`, original pin `2a57fa6dd53311f763bfc9abde85997b7f7e5309` (cross-branch). Untrusted suggestions — verified against current master tip `3ecdd20c1889df01109c73864a325c9fe5ea1d2c` before recording. **No runtime edits in this checkpoint. RD39 is not complete.**

### Four-state for RD39 journeys (on current master)

| Journey | State | Evidence on current master |
|---|---|---|
| C3 attachments | **concrete missing-code** (2 defects) + otherwise implemented | `DesktopConversation.beginUpload` still hard-refuses `files.length > 14`; document `add` still all-or-nothing; batch success ignores document result |
| C4 voice/mentions | **already implemented** (source); STT = root-config | Voice draft isolation, mention rename/delete blocking present on base; not re-audited as missing |
| C5 | **cross-ref C6 only** | Not a second implementation package |
| C6 secure/sign-in/takeover | **already implemented** (source); live OAuth = root-verify | Masked secret form, one sealed follow-up; live provider sign-in not claimed |
| C7 Actions/notifications | **concrete missing-code** (receipt) + otherwise implemented | Toast sets `status='shown'` then discards `bridge.notify` result |
| E3 browser/computer | **concrete missing-code** (paste) + otherwise implemented | `DesktopViewer.paste` always `clipboardPasteFrom`+Ctrl+V; `type()` Unicode path unused by Paste; `rfb-input` strips extended clipboard `0xc0a1e5ce` |
| E7 guest install | **already implemented** (source); Docker = root-verify | Single desktop installer path; no second installer |
| W3 templates | **already implemented** (source); hosted publish = product-decision | Delete/rollback/retry semantics present |

### Defects confirmed on current master (surgical recommendations — root/owners apply)

#### RD39-D1 · E3 non-Latin Paste (**SOURCE-REPAIRED** at `d7dc1685e2b2648c7a61c29ade8fa8a7b95992d0`)

- **Handoff:** `docs/desktop-round39-paste-handoff.md` · **INTEGRATION-PENDING / ROOT-UNVERIFIED** (guest native). Extended clipboard still disabled.
- **Local symbols:** `apps/ui/components/desktop/DesktopViewer.tsx` `paste` (uses `clipboardPasteFrom` + Ctrl+V); `type` + `keysymOf` already map >U+00FF; `apps/engine/src/desktop/isolated-screen/rfb-input.ts` strips extended clipboard encoding.
- **Original:** pin `DesktopViewer.tsx` clipboardPasteFrom; Unicode keysym path is the intended non-Latin adaptation while extended clipboard stays disabled.
- **Trigger / consequence:** Paste of code points >U+00FF while driving isolated screen → legacy ClientCutText keeps low 8 bits → wrong characters.
- **Surgical repair (root/E3):** If any code point >U+00FF, route through existing `type()`; keep Latin-1 on clipboard+Ctrl+V. **Do not** re-enable extended clipboard.
- **Owner:** E3 / root native guest verify.
- **Unrun regression proposal:** Paste `café` / `こんにちは` into guest field+terminal; Latin-1 still clipboard path; encodings still stripped; sibling screen untouched; Stop mid-type does not leak to Mac clipboard.

#### RD39-D2 · C3 hard >14 refuse (confirmed)

- **Local:** `DesktopConversation.beginUpload` `if (files.length > 14) { ... return }`.
- **Original:** pin capacity keeps files that fit and reports overflow (`prompt-input` / `maxFiles` math).
- **Trigger / consequence:** Mixed drop >14 (e.g. 10 text + 4 images + 1 PDF) attaches nothing.
- **Surgical repair:** Remove hard return; let per-kind preflight reject overflow in selection order with per-file reasons. Root owns `DesktopConversation` mount.
- **Owner:** C3 / root central conversation.
- **Unrun regression proposal:** 10 txt+4 png all attach; +1 txt names overflow; 15 txt keeps first 10; quit mid-batch preserves flushed draft only.

#### RD39-D3 · C3 document group all-or-nothing + batch ignore (**SOURCE-REPAIRED** hook at `2520a0ef3d483bd29c66e12fdb4ebfd37761a4bb`; conversation **INTEGRATION-PENDING**)

- **Handoff:** `docs/desktop-round39-document-attachments-handoff.md` · root must await `documents.add` + remove >14 early return (D2).
- **Local:** `useDesktopDocumentAttachments.add` returns `[]` if **any** file empty/>16MB with “Nothing was attached.”; `beginUpload` document branch does not await `documents.add`; batch success compares only text/image `failureVersion`.
- **Trigger / consequence:** One bad PDF drops valid sibling PDFs; batch can look successful after partial attach; ordering vs later image group races.
- **Surgical repair:** Per-file accept/reject from document start; await and fold into batch success; do not reject valid neighbor. No second uploader.
- **Owner:** C3 / root central conversation + document-attachments hook (root-owned mount).
- **Unrun regression proposal:** Ordered mixed drop; one oversized PDF keeps sibling; uncertain image blocks Send; cancel one chip; restart restores tab-scoped draft/docs only.

#### RD39-D4 · C7 native delivery receipt vs toast (confirmed; audit repair pushed back)

- **Local:** `useDesktopNotificationDelivery` sets `status = 'shown'` after toast, awaits `bridge.notify` but **discards** its result; `apps/desktop/src/main/notifications.mjs` returns `failed`/`unknown`; `finishDesktopNotificationAttempt` inserts seen only for `shown`.
- **Trigger / consequence:** Native `failed`/`unknown` still recorded as `shown` → cooldown retry suppressed; contradicts shell “refused OS delivery stays retryable.”
- **Audit suggested** removing `bridge.notify` so toast-only matches receipt.
- **Master evaluation (t18u):** Original native click / pending / receipt semantics must be **preserved**. Disabling the native channel only to mask a receipt bug is **not** an approved product change.
- **Truthful recommended repair:** Keep `bridge.notify` when toast channel admits native delivery. Set durable `status` from the **native** result when the bridge call is made (`shown`/`failed`/`unknown`/`unavailable`). On `failed`, delete/release that attempt without inserting `desktop_notifications_seen` (per existing finish semantics). Toast may still display; receipt must not claim native success the shell denied. Leave click resolution / payload wiring intact. **Do not** add OS banner prompts or a second inbox.
- **Owner:** C7 / root notification delivery.
- **Unrun regression proposal:** Toast opens exact owner/chat/request; native failed leaves event retryable; shown does not replay after restart; preferences off → no toast and no Electron Notification; Done vs pending semantics unchanged.

### Already-implemented claims accepted as source-present (not native acceptance)

C3 draft/queue/image cap 4 / text 10; C4 voice/mentions; C6 sealed follow-up; E3 guest timeout source; E7 single installer; W3 delete/rollback — as audited on `6f6ad959a09abaf1947950b6f82413c94407e22a`, still present on master lineage. **No source or native acceptance inferred.**

### Pending outside this reconcile

C–I seven-agent packages still PENDING. RD39 D1+D3 source-repaired (paste + document add); D2 >14 + D4 C7 still root/owner. RD40 W4/D4/D3/E2 source-repaired (nontext `42aa785f9b72…`, search `aed685747b0e…`); RD40 still not accepted. RD41 D1–D3 + Duplicate-grants discrepancy open. C7: keep native channel.


## RD40 frozen-base audit reconciliation (source review + one narrow repair)

**Audit source:** cloud agent asset `01M6S6Z5RSZHQX92H233BR0AH0.md` against frozen base `6f6ad959…`, original pin `2a57fa6…`. Untrusted until verified on master. Verified on tip before W4 repair (`92dc0250…`). **RD40 is not complete.** No checklist mutation.

| # | Candidate | State on master | Owner / gate |
|---|---|---|---|
| 1 | External `update_agent` grant bypass (`tools` / `selfImprovement` / grant aliases → engine merge without Tools consent) | **Source repaired** in external operations adapter only — `73b6855e6d227011fcd6198ce3ee71f1d640a94c`. Handoff: `docs/desktop-round40-w4-grant-guard-handoff.md`. **Not accepted / not tested.** Engine routes, scopes, defaults unchanged. | W4 adapter (done source); root live key verify later |
| 2 | Claude re-login `publicState` hides still-active token | **SOURCE-REPAIRED** `4415d3193bc467d0f25cbd9fdfdb3d76bf5c65f8` — `projectDesktopClaudePlanSnapshot` + `pendingAttempt`; handoff `docs/desktop-round40-claude-generation-handoff.md`. **ROOT-UNVERIFIED.** | D3; root fixture + optional live sign-in |
| 3 | Native non-text scratch writes vanish without unsupported receipt | **SOURCE-REPAIRED** `42aa785f9b72ca676bc473cab0f708f899db0d3f` — unsupported metadata-only rows (`binary-or-non-text`); handoff `docs/desktop-round40-nontext-writeback-handoff.md`. **ROOT-UNVERIFIED.** | E2 native writeback |
| 4 | Clear-all private semantic vectors residue (async observer) | **SOURCE-REPAIRED** `d0b2a79834261ad34e04abd4e9ce20e1f79cdc16` — after-lock bound `notesCleared`; clear mode skips swallowed reconcile; handoff `docs/desktop-round40-memory-clear-handoff.md`. **ROOT-UNVERIFIED.** | D4 private memory (not RD38 A portable) |
| 5 | Search rotated-key stale/uncertain receipt classification | **SOURCE-REPAIRED** `aed685747b0ee88fad99e90bf870650be997d990` — pre-flight capability-changed / in-flight uncertain; handoff `docs/desktop-round40-search-revision-handoff.md`. **ROOT-UNVERIFIED.** | E2 search binding |

**Preserved decisions:** RD39 C7 keep native `bridge.notify` (receipt from native result). W4 repair rejects whole mixed authority patch; metadata/Box/model fields remain.

### Proposed fragments (candidates 2–5 — do not apply this checkpoint)

- **D3:** **Applied** at `4415d3193bc467d0f25cbd9fdfdb3d76bf5c65f8` via projection + pendingAttempt (see handoff).
- **E2 nontext:** **Applied** at `42aa785f9b72ca676bc473cab0f708f899db0d3f` (see handoff).
- **D4:** **Applied outside lock** at `d0b2a79834261ad34e04abd4e9ce20e1f79cdc16` (deadlock avoided). See handoff. Keep best-effort reconcile for non-clear edits.
- **E2 search:** **Applied** at `aed685747b0ee88fad99e90bf870650be997d990` (see handoff).



## RD44 / RD45 conditional gates (plans sourced — not accepted, not implemented)

Read-only cloud plans against frozen base `6f6ad959…` + original pin `2a57fa6…`. **No mobile/hosting/cloud source changes in this checkpoint.** Local Mac readiness stays independent.

### RD45 — phone companion + Mac distribution (asset `01M6S85MF39SNP545DE226RXTS.md`)

- Pin phone app is Expo/Supabase **hub client** (bearer + `x-workspace-id`); **absent** on `6f6ad959` (zero `apps/mobile`, zero `/api/v1`).
- No public **phone↔local Mac** pairing / identity / revocation / workspace-mapping contract on either tree.
- Existing `POST /api/engines/pair` and remote-machine allowlist are **not** a phone protocol; do not retarget.
- User/root must choose: keep phone on pin hub (no Mac listener / no copied mobile tree) **or** authorize a new phone↔Mac contract before any port.
- Distribution canonical preview path/id/source versions unchanged (`Rerun Desktop Preview.app`, bundle `build.rerun.desktop.preview`). Signer SHA-1 is **user-provided**, not repo evidence. Notarization/update feed remain separate public-release work.
- **Status:** plan sourced · **not accepted** · **not implementation-complete** · do not port/activate.

### RD44 — hosted links / public webhooks / multi-user ACL (asset `01M6S8847DX06HMEYQVV73EZYP.md`)

- Hosted publish, public webhooks, and multi-user Box ACL remain **unmade** host/account/review/auth/rate/revocation decisions. Local milestone independent.
- Desktop-base `GET /p/[slug]` is the **older unguarded** stored `public_url` redirect; pin has stricter gate + 60s signed read. **MUST NOT** enable the old hosted route as a shortcut.
- Existing local loopback trigger auth/replay/rotate/custody remains legitimate; disabled networking stays off. No public listener from this lane.
- No vendor/host/accounts selected; no public service activated.
- **Status:** plan sourced · **not accepted** · **not implementation-complete**.

## RD41 frozen-base audit reconciliation (source review only — no runtime edits)

**Audit source:** cloud agent asset `01M6S74CTXEGPS2M7G67ZPH2VM.md` against frozen base `6f6ad959…`, original pin `2a57fa6…`. Verified read-only on current master after W4 tip `73b6855e…`. **RD41 is not complete. No duplicate/secret/env runtime edits. No UI panel edits (seven C–I / panel owners).** Canonical checklist not mutated.

### Confirmed defects (unrepaired)

#### RD41-D1 · Share plan file count includes credential paths; exclusion mislabeled `native-grant`

- **Local:** `createDesktopCoworkerSharePlan` counts every `workspace/` member (`snapshot.ts` ~113–124) without `scanPathForSecrets` / reserved-metadata filter. `includeMember` correctly drops secrets at pack time. `exclusionReason` has no credentials branch for `workspace/.env` / key material → falls through to `'native-grant'`.
- **Consequence:** Files switch overstates pack size; review labels credential paths as native grants. Bytes are not packed; explanation is wrong. Ordinary hidden user files (e.g. `.notes.md`) correctly remain eligible.
- **Surgical repair (root on canonical snapshot):** Align plan count + `exclusionReason` with `includeMember` predicate — label `scanPathForSecrets` hits `credentials`, reserved `.rerun`/`.rerun-skill-` as internal metadata, **before** pricing the files switch. **Preserve** ordinary hidden user files and nested/alias `.rerun*` / `.rerun-skill-*` exclusion (`isReservedTemplateMetadataPath` + `includeMember`).
- **Owner:** Root — `apps/engine/src/desktop/coworker-share/snapshot.ts` (canonical plan). **RD38 E** must consume this plan/manifest; **must not** invent a second exclusion filter in Share UI.
- **Unrun regression proposal:** Extend `snapshot.test.ts` — with files on, `.env` / `id_ed25519` absent from archive + plan count, present as `credentials`; `.notes.md` in plan+archive; `.rerun-backup-old` / `.rerun-skill-bak-old` out and uncounted.

#### RD41-D2 · DesktopBoard lacks per-workspace persistent camera

- **Original:** `IsoBoard` `board:<workspace.id>` via `readCamera`/`writeCamera`, remount key.
- **Local:** `DesktopBoard.tsx` mounts `IsoGrid` with `fitToContent` / `frameInset` / `recenterSignal` only — no `initialCamera` / `onCameraChange`. `isolation.mjs` claims board camera restores per workspace; renderer never writes one.
- **Same-session behavior to keep:** `userFramedRef` blocks fit while chat inset changes; Recenter remains explicit reset.
- **Surgical repair (root):** Persist camera scoped by workspace id (`board:<workspaceId>` or workspace `app.db` row); pass `initialCamera` so restore suppresses fit; leave chat open/close framing alone.
- **Owner:** Root / central `DesktopBoard.tsx` — not RD38 C Share/API/packaging/remote unless they already own that file.
- **Unrun regression proposal:** Pan/zoom survive chat open/close; quit/reopen and workspace switch restore per-workspace camera; Recenter then manual pan is what persists.

#### RD41-D3 · Five coworker panels use loading sentences instead of skeletons

- **Local sentences:** Files / Memories / Settings / Schedules / Tools (`Loading …`). Original used `SkeletonFileGrid` / `SkeletonPanelRows` / `SkeletonForm` / `SkeletonCardGrid`. Share options + Triggers already use skeletons.
- **Surgical repair:** Swap five sentences for matching existing skeletons; keep error `role="alert"` and empty copy.
- **Owner:** Each panel’s owner lane / seven-agent wave — **no UI edits in this master checkpoint.**
- **Unrun regression proposal:** Unresolved request → matching skeleton; resolve empty/error without leftover loading sentence.

### Duplicate / copy grants vs user t18u (do not accept audit “product decision” as override)

| Path | Actual source behavior | User / master requirement |
|---|---|---|
| Portable share / template import | `createDesktopCoworkerImportPlan` forces `grants: 'off'`; `scrubConfig` strips connection/provider/model/MCP/`tools`/native grants/selfImprovement | No inherited grants — **aligned** |
| Same-box Duplicate | `duplicate.ts` deliberately keeps full staged `config.json` (including tool grant bags) + `.env` + `mcp/`; desktop publisher copies `enabled` from source | **t18u RD41: copies/imports must not inherit grants/permissions** |

- **Discrepancy:** Same-box Duplicate **does** inherit grant-bearing config today. Audit bucketed this as a settled product decision; **master does not accept that override.**
- **Root authority split:** Root decides credential / `.env` / `mcp/` **copying** product semantics (commented intent: same owner, same box). Separately, **user-required no-grant inheritance** remains explicit — root must decide how Duplicate forces grants off (and related permission fields) without treating the audit’s blanket “product decision” as permission to keep inherited tool grants.
- **This checkpoint:** document only — **no** duplicate/secret/env runtime edits.

### Privacy rule reaffirmation (already on base; preserve)

`isReservedTemplateMetadataPath` + `includeMember` exclude `.rerun*` / `.rerun-skill-*` (nested + case aliases) and keep ordinary hidden user files. Do not “fix” by excluding every dotfile.

### Already-source-present notes (not acceptance)

Portable grants-off import; per-coworker desktop grants default off + execution recheck; Improve-itself master default on (schema); workspace DBs separated; Control Center failed-vs-empty; hosted Box ACL / Published tab / members admin = product/RD44 decisions (not this repair pass).


