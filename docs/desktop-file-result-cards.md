# Desktop file-result cards (C8)

Real `card_file` results now render as file tiles in the Mac coworker chat. A card is a recorded
path reference, not a snapshot of the bytes: opening a tile reads the file as it exists now through
the authenticated desktop Files route. Table cards remain unavailable.

## Original design reused

Reviewed at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/engine/src/tools/builtin/cards.ts` — `card_file` output shape and all-or-nothing card rule.
- `packages/contracts/src/chat-card.ts` — `fileCardSchema`, legacy single-file card and
  `CARD_MAX_FILES`.
- `apps/ui/components/chat/MessageView.tsx` — the `card_file` branch that replaces the generic tool
  step with a card.
- `apps/ui/components/chat/FileCard.tsx` — tile grid and lightbox behavior.
- `apps/ui/components/chat/AttachmentTile.tsx` — the original square tile, glyph and label.
- `apps/ui/components/chat/AttachmentLightbox.tsx` — the original title bar, paging and text preview.

The Mac keeps that tile and preview. It adds an optional `openable` tile for a text card with no raw
URL, and a `DesktopFileLightbox` that mirrors the original title bar, paging and text preview but
has no raw URL or download. The shared `AttachmentLightbox` is unchanged.

## Implemented

- **Grant/catalog:** `cardFile` is a supported per-coworker Rerun grant with the `card_file` tool.
  It is independent of `workspaceRead`; turning on one does not turn on the other. The old pending
  `cards` catalog row is now a `Table cards` unavailable row, since desktop has no saved table views.
- **Engine tool:** `apps/engine/src/desktop/card-file.ts` shows only existing visible `.txt`/`.md`
  files in that coworker’s workspace. It re-reads the current coworker and grant before every call,
  uses `openWithoutLinks`, checks the same inode twice, rejects symlinks, hard links, directories,
  foreign/absolute/traversal paths outside the workspace, shared scope, unsupported extensions and
  files over 32 KiB, and allows at most 12 files. An absolute path inside this workspace is
  normalized to the relative path the Files route opens; a foreign absolute path is refused. One
  bad file means nothing is shown.
- **Codex bridge:** the tool is merged into the desktop `buildTools` set, so the existing dynamic
  tool bridge exposes it when the catalog grant is on. No separate runner or model path was added.
- **Parser/projection:** `apps/ui/lib/desktop/file-card.ts` validates live and saved output: JSON
  string, text/json wrapper, parsed card or legacy single-file card. It keeps only validated
  `path`/`name`/`size`/`scope: agent` fields. `publicDesktopHistory` preserves that validated card
  for a saved `card_file` result so it stays on the correct assistant message after restart.
- **Rendering:** `DesktopAssistantReply.tsx` replaces the generic `card_file` step with
  `DesktopFileCard` only when the parser accepts the recorded output. A malformed card keeps the
  original expandable tool-result step. Reasoning, tool steps, sources, feedback and suggestions
  are unchanged.
- **Opening:** `DesktopFileCard` reads text through
  `GET /api/desktop/agents/:agentId/files/read?path=…` when a tile is opened. A deleted, renamed or
  unreadable file shows the preview’s unavailable state; no bytes are cached in the card.

## Changed files

- `packages/contracts/src/desktop-tool-grants.ts` — `cardFile` grant and catalog row; table-card
  pending row corrected.
- `apps/engine/src/desktop/card-file.ts` — the opt-in `card_file` tool and its confinement checks.
- `apps/engine/src/tools/registry.ts` — adds the desktop card tool to the existing toolset.
- `apps/engine/src/desktop/workspace-read.ts` — exports the shared workspace root/path helpers.
- `apps/engine/src/desktop/question-tool.ts` — mentions card_file only when its grant is on.
- `apps/engine/src/agents/systemPrompt.ts` — desktop card guidance without hosted table-cards text.
- `apps/ui/lib/desktop/file-card.ts` — card output parser and authenticated read helper.
- `apps/ui/components/desktop/DesktopFileCard.tsx` — tile grid wrapper.
- `apps/ui/components/desktop/DesktopFileLightbox.tsx` — text-only original preview dialog.
- `apps/ui/components/desktop/DesktopAssistantReply.tsx` — card branch, `agentId` prop and fallback.
- `apps/ui/components/chat/AttachmentTile.tsx` — optional `openable` text tile (default unchanged).
- `apps/ui/lib/chat/engine-history.ts` — preserves validated saved cards in desktop history.
- Tests: `apps/engine/src/desktop/card-file.test.ts`, `apps/ui/lib/desktop/file-card.test.ts`,
  `apps/ui/components/desktop/DesktopFileCard.test.tsx`,
  `apps/ui/components/desktop/DesktopAssistantReply.test.tsx`,
  `apps/ui/lib/chat/engine-history.test.ts`.

## Integration contract for root-owned wiring

`@rerun/contracts` must be rebuilt first: the new `cardFile` grant id and catalog row live there,
and both the engine and UI consume its `dist`. Then `DesktopConversation.tsx` must pass the trusted
local coworker id to the reply:

```tsx
<DesktopAssistantReply
    message={message}
    streaming={/* existing value */}
    agentId={agent.id}
    /* existing props unchanged */
/>
```

That is the only root-owned wiring. Without `agentId`, the recorded tiles still render but stay
inert, as a read-only transcript would. The Tools panel needs no change: it reads the shared grant
catalog and now shows **Show result files** for the selected coworker.

## Remaining limits

- Only existing `.txt`/`.md` files are carded. Images, PDFs, shared files, folders, symlinks and
  downloads are not supported by this slice.
- A card is not an attachment snapshot. Its path and name are recorded at card time; opening may
  show current content, or the preview’s `This file could not be read` state after a rename/delete.
- Native Codex commands and edits use a separate temporary folder. A card does not publish that
  folder’s output: it only addresses the existing persistent Files workspace. Tool and system
  guidance explicitly distinguish temporary edits from a same-named persistent original.
- The card tool accepts up to 32 KiB per file. The existing Files preview route may show a larger
  text file truncated; the preview displays the existing Files notice, `Preview shows the first
  256 KB.` The card itself still only points at the file.
- Revoking the grant stops new cards. An already-saved card remains a saved historical result and
  can still be opened through the Files preview.
- Table cards remain unavailable until desktop can expose saved table views.

## Verification status

Authored, not executed by this lane: engine grant/tool tests, parser tests, read-helper tests,
`publicDesktopHistory` projection tests and `DesktopAssistantReply` card/fallback tests. I did not
run Vitest, `tsc`, lint, a build, an install, a live model call or native Mac QA, and I did not touch
the real workspace, credentials, installed app, packaging or another worktree.
