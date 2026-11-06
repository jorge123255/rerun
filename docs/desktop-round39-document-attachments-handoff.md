# RD39 C3 document attachments per-file add handoff

**Kind:** narrow source repair — **not** RD39 complete, **not** accepted, **not** tested.  
**Branch:** `desktop/round38-master-completion`  
**Frozen base:** `6f6ad959a09abaf1947950b6f82413c94407e22a`  
**Original pin:** `2a57fa6` prompt-input keeps capacity-fitting files and names overflow (`apps/ui/components/ai-elements/prompt-input.tsx`); Mac document hook previously all-or-nothing on empty/oversized.  
**Impl SHA:** `0f23d59dced2449c30ca0b4b8e4e9a1d409213c3`  
**Parent tip before this commit:** `d7dc1685e2b2648c7a61c29ade8fa8a7b95992d0`

## Change

| Path | Role |
|---|---|
| `apps/ui/lib/desktop/document-attachments/plan-document-add.ts` | Pure ordered planner + `DesktopDocumentAddResult` / outcome types + error summary |
| `apps/ui/lib/desktop/document-attachments/plan-document-add.test.ts` | Authored **unrun** pure regressions |
| `apps/ui/lib/desktop/document-attachments/useDesktopDocumentAttachments.ts` | `add` returns typed result; per-file accept/reject; sibling success preserved |
| `apps/ui/lib/desktop/document-attachments/useDesktopDocumentAttachments.test.tsx` | Extra **unrun** hook regression for mixed empty+eligible |

**Not edited:** `DesktopConversation.tsx`, composer mounts, binary/audio/video accept lists, A/B engine, Duplicate/grants.

## Typed result port (for root)

```ts
export type DesktopDocumentAddResult = {
  outcomes: DesktopDocumentAddOutcome[]  // input order
  attachedIds: string[]
  error: string | null                 // null if all attached; includes "Nothing was attached." only when none attached
}
// outcome: { status:'attached', name, byteLength, attachmentId, position }
//        | { status:'rejected', name, byteLength, reason, message }
```

Re-exported from `useDesktopDocumentAttachments.ts`.

## Root fragments (INTEGRATION-PENDING — do not apply here)

### 1. Await documents.add and fold failures into batch status

In `DesktopConversation.beginUpload` document branch (~line 374), replace fire-and-forget with:

```ts
else if (kind === 'document') {
  if (!tabUid) throw new Error('Open a saved chat tab before adding documents.')
  const docResult = documents.add(group)
  if (docResult.error) reportUploadNotice(docResult.error) // or batchNotices.current.push(...)
  // Treat any rejected outcome as a batch soft-failure bit if you mirror text/image failureVersion:
  // e.g. docFailed = docResult.outcomes.some(o => o.status === 'rejected')
}
```

And include that bit in the final `batchOkay` / settle gate so mixed text/image success cannot hide document rejects.

### 2. Remove hard `files.length > 14` early return (~line 357)

Replace with per-kind capacity (text 10 / image 4 / document 10) already enforced inside each uploader; let ordered drain run. Overflow notices come from each start/add. **Root owns** `DesktopConversation.tsx`.

## Unrun regressions (not executed)

- Empty/oversized neighbors do not drop later eligible PDFs.
- Count and total-byte capacity reject overflow while keeping earlier accepts; smaller sibling can still fit after a too-large-for-budget neighbor.
- Retain-full per file.
- Summary: "Nothing was attached." only when zero attaches.
- Hook: mixed `ok.pdf` + empty + `also.pdf` → two uploads, typed outcomes.

## Unsupported / risks

- `add` return type changed from `string[]` to `DesktopDocumentAddResult` — current conversation ignores return (safe); any external caller expecting `string[]` must use `.attachedIds`.
- Does not invent attachments for unsupported kinds; does not broaden accept MIME.
- Does not fix >14 total early return (root fragment above).

## Proposed PR text

`fix(desktop): per-file document attach outcomes instead of all-or-nothing`

Plan document adds in selection order so empty or oversized neighbors leave eligible siblings attached, and return a typed outcome list for the conversation batch gate.

## Status

SOURCE-REPAIRED (hook + planner) · INTEGRATION-PENDING (conversation await + >14) · ROOT-UNVERIFIED · tests not run · no push/PR · checklist not mutated
