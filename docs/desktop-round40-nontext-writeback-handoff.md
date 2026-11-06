# RD40 E2 native non-text writeback unsupported receipt handoff

**Kind:** narrow source repair — **not** RD40 complete, **not** accepted, **not** tested.  
**Branch:** `desktop/round38-master-completion`  
**Frozen base:** `6f6ad959a09abaf1947950b6f82413c94407e22a`  
**Original pin:** `2a57fa6dd53311f763bfc9abde85997b7f7e5309` (read-only RD40 audit prior)  
**Parent tip before this commit:** `c43c532dad511ed1c483d142e2345570418e0c73`  
**Impl SHA:** `42aa785f9b72ca676bc473cab0f708f899db0d3f`

## Defect (verified)

Scratch can receive non-`.txt`/`.md` (and binary) via shell. `captureNativeChanges` only scanned `allowedTextPath` (`.txt`/`.md`). Empty text proposals skipped `persist`, then finish deleted scratch — no review row. `fs/writeFile` refused binary/non-UTF8 with a generic “unavailable” message.

## Change

| Path | Role |
|---|---|
| `apps/engine/src/desktop/native-writeback/capture.ts` | Scan path-safe non-text; emit `unsupported[]` (`reason:'binary-or-non-text'`) with parents only — **no file bytes**; text proposals unchanged |
| `apps/engine/src/desktop/native-worker.ts` | Persist when `files` **or** `unsupported` nonempty; `fs/writeFile` requires `allowedTextPath` + truthful unsupported refuse message |
| `apps/engine/src/desktop/native-writeback/capture.test.ts` | Unrun: text+binary, all-binary, unchanged non-text silent, symlink/hidden skipped, oversize metadata-only |
| `apps/engine/src/desktop/native-writeback/outbox.test.ts` | Bundle includes `unsupported:[]` |
| `apps/ui/lib/desktop/server/native-writeback/service.ts` | Accept `unsupported`; store `state:'unsupported'`; list without after bytes; decide returns `unsupported` (never apply) |
| `apps/ui/lib/desktop/server/native-writeback/service.test.ts` | Unrun: mixed receipt, all-binary nonempty, text approve only persists |

**Preserved:** text digest/conflict/approval; path confinement; symlink skip; hidden/internal skip; credential/outside redaction; no binary into portable/live workspace/history/model result; no historical-card rerun; no migration (state TEXT already).

## Bundle fragment (engine + UI codec — no second codec)

```ts
unsupported: { path; reason: 'binary-or-non-text'; parents: { path; identity }[] }[]
// files may be empty when unsupported.length >= 1
// review row: state 'unsupported', after '', before null, optional reason
```

## Root / dependent labels

- **Mounted:** engine `persistNativeWriteback` → UI capture/list already bound when `nativeWriteback` grant on (loop + mcp-binding). Unsupported rows ride that existing result seam.
- **Not edited (root):** `loop.ts`, contracts barrels, migrations, route registration, global tool registry, `DesktopNativeWritebackReview.tsx` (already renders non-`pending` as `{path}: {state}`).
- If a future UI wants explicit `binary-or-non-text` copy beyond `state`, consume `NativeReview.reason` — no second schema.

## Unrun regressions (not executed)

text+binary → md pending + bin unsupported; all-binary nonempty receipt; symlink/hidden not listed; oversize non-text metadata-only; no bytes in JSON; text approve persists once; unsupported decide never save/create; restart list keeps `unsupported`; writeFile binary/non-txt truthful refuse; unchanged copied `.bin` silent.

## Execution NOT run

No vitest/typecheck/lint/build/install/fixtures/provider/network/Keychain/live data/UI/Docker/listeners/restart/push/PR.

## Remaining gates

Search credential-revision receipt (next package). C–I / root central conversation+notifications / RD41 root snapshot-board-panels / copy-grants remain pending. Do **not** mark whole RD40 accepted.

## Proposed PR text

**Title:** `fix(desktop): emit unsupported native writeback receipts for non-text scratch`

**Body:** Capture added/changed non-`.txt`/`.md` scratch paths as metadata-only `unsupported` review rows (`binary-or-non-text`). Persist when unsupported nonempty; never apply or retain binary bytes. Keep text digest/conflict approval and stronger writeFile refuse messaging.

## Status

SOURCE-REPAIRED · ROOT-UNVERIFIED · tests not run · no push/PR · checklist not mutated · RD40 not accepted
