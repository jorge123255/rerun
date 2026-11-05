# Desktop company brain proposals

Lane handoff for D8 proposal review and the coworker read, search, and propose tools. Root execution and native Mac acceptance are pending. This commit does not mark D8 accepted and does not edit `docs/desktop-parity-checklist.md`.

Original source pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

## Original sources

Read these. This lane did not edit them.

- `apps/engine/src/tools/builtin/brain.ts` — `brain_search`, `brain_read`, `brain_propose`, and the proposal result JSON. Desktop does not register `brain_write`, `brain_delete`, `brain_decide`, or `brain_proposals`.
- `apps/engine/src/brain/proposals.ts` — fingerprint, replace-open, outdated rule, and `acceptProposal`. Hosted accept calls `writePage` with `force: true`. This lane does not call `acceptProposal` or `writePage`.
- `apps/engine/src/brain/search.ts` — hosted search embeds through `/api/embed` and fuses FTS with RRF. Desktop search does not call it.
- `apps/engine/src/brain/pages.ts` — `pageHash` and `parsePage`. Desktop copies the hash formula and the markdown parse. It does not import this module, because the module schedules embeddings.
- `apps/engine/src/http/routes/brain.ts` — hosted page, proposal, and seed routes. Desktop does not mount this router.
- `apps/ui/components/brain/BrainProposalsPanel.tsx`, `proposals/ProposalCard.tsx`, `ProposalList.tsx`, `parts.tsx`, and `Prose.tsx` — the review layout. The desktop panel reuses the list, card, and page column.
- `apps/ui/components/brain/BrainWorkspace.tsx` case `'proposals'` — still renders the hosted panel. Root or H swaps it.
- `apps/ui/components/chat/BrainProposalBlock.tsx` and `MessageView.tsx` — the hosted Review button calls `openKnowledgeBase('proposals')`. Root swaps the block.
- `apps/ui/app/api/_actions/brain.actions.ts` — a failed hosted load becomes `[]` or count `0`. Desktop must not copy that.
- `packages/contracts/src/brain.ts` — proposal and page schemas. Not edited.
- `packages/contracts/src/chat-tool-display.ts` — labels for `brain_read`, `brain_search`, and `brain_propose` already exist. Not edited.

## Files in this lane

- `apps/engine/src/desktop/brain-proposals.ts` — shared store, read-only page reader, and keyword search. The UI imports this so it does not import the `ai` tool module.
- `apps/engine/src/desktop/brain-tools.ts` — `desktopBrainTools(ctx)`.
- `apps/ui/lib/desktop/server/brain-proposals.ts` — authenticated server boundary.
- `apps/ui/lib/desktop/brain-proposals.ts` — browser client. Relative `/api/desktop/brain/proposals` only.
- `apps/ui/app/api/desktop/brain/proposals/route.ts` — `GET`.
- `apps/ui/app/api/desktop/brain/proposals/count/route.ts` — `GET`.
- `apps/ui/app/api/desktop/brain/proposals/[proposalId]/accept/route.ts` — `POST`.
- `apps/ui/app/api/desktop/brain/proposals/[proposalId]/dismiss/route.ts` — `POST`.
- `apps/ui/components/desktop/brain/proposals/DesktopBrainProposalsPanel.tsx`
- `apps/ui/components/desktop/brain/proposals/DesktopBrainProposalBlock.tsx`
- `apps/engine/src/desktop/brain-proposals.test.ts`
- `apps/ui/app/api/desktop/brain/proposals/route.test.ts`

No new package. `gray-matter` is already an engine dependency. Do not install anything, and do not call hosted embeddings.

## Storage

Tools resolve `realpath(dataDir())`. The UI resolves `realpath(join(dataRoot, 'workspaces', '1', 'engine'))`. Requests cannot pass a root, an engine id, or a private-memory path.

- Pages are read only from `<engine>/brain/<slug>.md`.
- Proposals are `<engine>/brain-proposals/<id>.json`, mode `0600`, one hard link. They are not inside `brain/` and they are not the hosted `brain_proposals` table.
- A missing proposal directory is an empty inbox and count `0`. A missing engine directory is `404` `The company brain is not ready.`
- A corrupt proposal fails the list and the count. It is not `{ proposals: [] }` or `{ count: 0 }`.
- `decidedBy` is always `user:desktop`. A client `decidedBy` is `400` `The decision author is set by this Mac.`

`brain_propose` returns `{ status: 'proposed'|'updated', proposalId, slug, title, message }`. The chat card matches that JSON, not the tool-call id.

## Decisions

Accept and dismiss record a row. `applied` is always `false`. Nothing in this lane writes a markdown page.

- The same decision again returns `200` with `unchanged: true`, the stored `decidedAt`, `decidedBy`, and `pageWrite`. A later edit in that retry is ignored.
- The opposite decision is `409`. The stored decision does not flip.
- An accept whose page moved, or a create whose page now exists, is `409` `The page changed since the coworker read it. The proposal is still waiting, and the page was not written.` The row stays `proposed` and `outdated`.
- Dismissing an already dismissed proposal returns the stored decision. Accepting it afterward is `409` `This proposal was already dismissed. The page was not written.`
- A dismissed fingerprint blocks every coworker from proposing that same change. The message is `This exact change was already proposed once. Nothing sent, and do not raise it again.`
- The same coworker’s still-open proposal for a slug is replaced in place. The id stays, `createdAt` is new, and the status stays `proposed`.

`pageWrite` is set only for an acceptance:

- `force` is always `false`.
- `author` is `agent:<agent name>`, the hosted `writePage` author. It is not `user:desktop`.
- `baseHash` is the live page hash checked at accept time, or `null` when the page is still absent.
- `sources` stay the proposal’s sources.
- Optional `content`, `title`, and `type` on the accept body are stored in `pageWrite`. `BrainProposal.content` stays the coworker’s text.
- The review panel posts `{}`. It does not send those edits.

G applies a payload only when `applied === false`, `conflict === false`, `unchanged === false`, and `pageWrite` is non-null. Re-check the live page. A create still requires the page to be absent. An edit requires the live hash to equal `pageWrite.baseHash`. Do not pass `force: true`. If the page moved, do not write; leave this row `accepted` and show the conflict. `GET ?status=accepted` returns that row. The inbox defaults to `proposed`, so an accepted row leaves the inbox even when the page is not written yet. A `409` body is `{ error }` only. `conflict: true` is not returned for the stale path.

## Mac adaptations

- Hosted `acceptProposal` writes the page with `force: true`. Here the decision is the whole result.
- Hosted search uses embeddings, `brain_chunks_fts`, and RRF `k=60`. Here a keyword score is title `5`, slug `3`, body `1`. Related pages come from `[[links]]` in the markdown, at most 8. Passages are the top 2. No `fetch` and no `/api/embed`. More than 2000 directory entries returns `413` `The company brain is too large to search this way.`
- Hosted `GET` without a status returns every status. Desktop defaults to `proposed`. `accepted` and `dismissed` are explicit. Any other value is `400`.
- The hosted actions turn a failed load into an empty inbox. `DesktopBrainProposalsPanel` keeps `proposals === null` for the skeleton, shows the error text on failure, and lets `ProposalList` show All caught up only for a real empty array.
- The panel subtitle is `Accept and dismiss record the decision. The page is not written from here.` The accept toast is `<title> accepted` with `The page was not written. The Brain page store still has to apply this decision.` The original toast said the page was updated.
- `DesktopBrainProposalBlock` matches the hosted card. Review renders only when `onReview` is passed. It does not call `openKnowledgeBase`.
- The propose tool says there is no `brain_write`, including for a fact the user just said, and that the model must not say the page was saved. Search says keyword, not meaning.
- The model grant is `desktopToolGrants.brain === true`, plus an enabled coworker and `tools.brain !== false`. It is separate from `tools.brain`’s hosted default of `true`. Human review does not need the grant. The adapter casts the grant record and does not call `requireDesktopToolGrant(ctx, 'brain')`, because `'brain'` is not in the enum yet. Bind returns `{}` when the grant is off. Execute checks again before the work and again in `beforeCommit`, immediately before the JSON rename. A deletion marker still throws `This coworker is being deleted. Try again.`

## Root wiring

Do not default the grant to true. Do not add `brain_write`. Leave `apps/engine/src/agents/systemPrompt.ts` unchanged; it already uses `desktopToolInstruction`.

`packages/contracts/src/desktop-tool-grants.ts`: add `'brain'` to `desktopRerunGrantIds`. Replace the pending brain row with:

```ts
supported('brain', 'Company brain', 'Read, search, and propose changes to the workspace company brain. A person accepts or dismisses each proposal. Nothing is written until that decision is applied by the page store.', 'brain_read', 'brain_search', 'brain_propose'),
```

`apps/engine/src/tools/registry.ts`, inside the existing `if (desktopApp())` tool object only:

```ts
import { desktopBrainTools } from '../desktop/brain-tools.js'
// ...desktopSkillTools(ctx),
...desktopBrainTools(ctx),
```

Do not also spread `brainTools(ctx)` or `foremanBrainTools()`.

`apps/engine/src/desktop/tool-grants.ts`, in `hasDesktopToolGrant`, after the grant record has already failed closed:

```ts
if (id === 'brain') return config.tools.brain !== false
```

In `desktopToolInstruction`, when `enabled.has('brain')`, append this sentence and no path:

```ts
const brain = enabled.has('brain')
    ? ' brain_read, brain_search, and brain_propose use the workspace company brain, the same pages for every coworker. brain_propose only files a review. It does not write, and brain_write is unavailable. A person accepts or dismisses the proposal. Private memories stay on the memory tools.'
    : ''
```

Add `${brain}` to that return, beside the shared-files and web sentences.

`apps/ui/components/brain/BrainWorkspace.tsx`, case `'proposals'`:

```tsx
import { DesktopBrainProposalsPanel } from '@/components/desktop/brain/proposals/DesktopBrainProposalsPanel'

case 'proposals':
    return <DesktopBrainProposalsPanel onOpenPage={openPage} />
```

Do not pass `available ? proposals : []`.

`apps/ui/components/chat/MessageView.tsx`, for `brain_propose` output whose status is `proposed` or `updated` and whose `title` is set:

```tsx
import { DesktopBrainProposalBlock } from '@/components/desktop/brain/proposals/DesktopBrainProposalBlock'

<DesktopBrainProposalBlock title={out.title} mode={input?.baseHash ? 'edit' : 'create'} onReview={openDesktopBrainProposals} />
```

`openDesktopBrainProposals` is root’s callback into the desktop proposals panel. Omit `onReview` and the Review button is absent. Do not call `openKnowledgeBase`. Do not render `BrainChangeBlock` for these three tools.

The count route is `GET /api/desktop/brain/proposals/count`. It returns `{ count }` for open proposals only, and an error status when the read fails. Root owns Control Center, the menu, and navigation. This lane adds no command.

`apps/ui/proxy.ts` already allows `/api/desktop/`. Leave `desktopRouteAllowed` without a hosted `/brain` exception.

## Routes

All four routes are `dynamic = 'force-dynamic'`, `runtime = 'nodejs'`, and `cache-control: no-store`.

- `GET /api/desktop/brain/proposals?status=` optional `proposed`, `accepted`, or `dismissed`. Default `proposed`. Body `{ proposals }`. At most 100, newest first.
- `GET /api/desktop/brain/proposals/count` body `{ count }`. The count is every open proposal, not the capped list.
- `POST /api/desktop/brain/proposals/:proposalId/accept` body `{}` or `{ content?, title?, type? }`.
- `POST /api/desktop/brain/proposals/:proposalId/dismiss` ignores its body.

There is no page, seed, raw, or media route.

## Regression sources

Root runs these. This lane did not run them, and did not run typecheck, lint, build, packaging, an app server, a model call, or Mac/restart QA.

- `apps/engine/src/desktop/brain-proposals.test.ts` — accept and retry leave the markdown bytes unchanged; stale create and edit stay proposed; dismissal is stable and blocks both coworkers; replace keeps the id; keyword search misses a private memory file and does not call `fetch`; symlink pages and proposal directories are refused; a second link on a proposal JSON is refused; a leftover `.id.lock` is `409`; the list caps at 100 while the count does not; a corrupt file is an error; the tool set is only `brain_read`, `brain_search`, and `brain_propose`; a missing grant, `tools.brain === false`, a disabled coworker, cancellation, and a deletion marker are refused.
- `apps/ui/app/api/desktop/brain/proposals/route.test.ts` — missing engine is `404`; a missing proposal directory is empty; corrupt JSON and a symlinked proposal directory are errors and do not echo outside bytes; accept, retry, dismiss, a client `decidedBy`, a stale page, and a create acceptance leave the page bytes unchanged.

The panel and the chat block have no DOM test. The panel is the hosted list and card with its own loader.

## Remaining limits

- `'brain'` is absent from `desktopRerunGrantIds`, so a stored grant is stripped and the tools stay unregistered until root applies the wiring above. Do not turn the grant on by default.
- Accept never writes a page. `pageWrite.force` is false. G owns the page write.
- No embeddings, FTS, or RRF. If G later indexes chunks, that indexer must not call `/api/embed` from this module.
- Two concurrent proposes can both pass the fingerprint check. There is no cross-process lock around insert.
- A crash can leave `<engine>/brain-proposals/.<id>.lock`. The next decision returns `409` until that file is removed. There is no sweeper.
- Page reads allow a hard link. Proposal JSON requires `nlink === 1`.
- A symlink named `brain` or `brain-proposals`, or a symlink page or proposal file, is refused. `workspaces/1/engine` itself is resolved with `realpath`.
- Wrong-uid refusal and the Linux `O_NOFOLLOW` path were not executed here.
- Hosted Review still opens the hosted knowledge base until root swaps `MessageView`. The proposals case in `BrainWorkspace` still mounts the hosted panel until root or H swaps it.
- No private-memory reuse, automatic learning, website seeding, or service credentials.
