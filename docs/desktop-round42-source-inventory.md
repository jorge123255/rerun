# RD42 source inventory (preparation — not complete)

**Status:** independent RD42 preparation checkpoint only. Does **not** claim release-candidate completion, Mac acceptance, or that RD39–41 / C–I are done.  
**Worktree tip at inventory authorship:** `406cb2661544e6d6828c36a6c4f8732d2281b3b7` on `desktop/round38-master-completion`  
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
| **RD39** local journey audits/fixes | PENDING — cloud readonly audit on base; implementation later |
| **RD40** providers/recall/Foreman compose | PENDING — cloud readonly audit on base; implementation later |
| **RD41** whole-product design/state audit | PENDING — cloud readonly audit on base |
| **RD42** RC repair + root acceptance | **this doc is preparation only** — not finished |
| RD43 remote host acceptance | product/host gate |
| RD44 hosted share/webhooks/collaboration | product/authority gate |
| RD45 mobile + public distribution | product/signing gate |

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

#### RD39-D1 · E3 non-Latin Paste (confirmed)

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

#### RD39-D3 · C3 document group all-or-nothing + batch ignore (confirmed)

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

C–I seven-agent packages; RD40–41 audits; applying the four repairs (root/central owners).

