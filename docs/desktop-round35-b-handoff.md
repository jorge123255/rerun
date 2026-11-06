# Round 35 — Agent B handoff: company research synthesis and reviewed Brain handoff (E11 / D8)

Worktree `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round35-company-brief`, branch `desktop/round35-company-brief`, base `5c0f589b51a8129d097f2b97fc420a8acf859b51`. Original pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

**No tests, typecheck, lint, build, install, server, Docker, provider call, browser, Keychain, or Mac/restart check was executed. This commit is not installed acceptance. E11 and D8 stay open.** Root reviews, repairs, and accepts.

## Dependent contract

Agent A branch `desktop/round35-company-discovery` was read at `5c0f589b51a8129d097f2b97fc420a8acf859b51` (same base, clean, no `desktop-company*` file). No newer snapshot contract was published.

This package does not invent one. The immutable input is the existing `DesktopForemanDiscoveryRun` / `foremanDiscoveryRunSchema` in `packages/contracts/src/desktop-foreman.ts`, `DESKTOP_FOREMAN_CONTRACT_VERSION = 1`. If A later publishes a different snapshot, root rebinds `companyBriefSynthesizeSchema.snapshot`. Do not keep a second discovery record.

## Original mapping (pin a6d63a4)

| Original | Local |
| --- | --- |
| `apps/ui/lib/company/explore/synthesize.ts` brief sections, source tags, "only state what a source supports", model `RERUN_COMPANY_BRIEF_MODEL` / `anthropic/claude-sonnet-5.5` | `companyBriefPrompt` keeps those rules and section names. Desktop calls only the explicit saved model. The env default and the provider fallback ladder are not used. |
| `CollectorSkipped('Aucune source à synthétiser')` | Same string, status `skipped`, no model call, when the snapshot has no citable finding. |
| `apps/ui/lib/company/explore/findings.ts` labels and card copy (`Found you`, `Who you sell to`, `Products`, `Competitors`, `Customers`, `DISCOVERY_SOURCE_LABELS`) | Review panel uses `DESKTOP_FOREMAN_SOURCE_LABELS` and those finding labels. Board overlay `DesktopBoardDiscoveries` is not edited. |
| `apps/ui/lib/brain/seed-pages.ts` `buildSeedPages`, source-tag regex, open-questions sentence | Selected claims become proposal pages on the same slugs (`company`, `offering`, `market`, `team`, `stack`, `open-questions`). Presence stays on `market`. Open questions use "The research could not answer these. Confirm them and update the matching page." |
| `apps/ui/trigger/seed-company-brain.ts` + `apps/engine/src/brain/seed.ts` direct `seedBrain` / `writePage` | Not called. Approved claims go through `DesktopBrainPagesStore.propose` only. `decideProposal` is not called. |
| `apps/engine/src/desktop/brain-proposals.ts` fingerprint, expected page hash, duplicate | Handoff passes `baseHash` from a fresh `readPage`. A hash mismatch or a deleted page is `page_changed` and does not propose. `propose` returning `duplicate` is recorded and not accepted. |

## Implementation inventory

- `packages/contracts/src/desktop-company-brief.ts` — contract version 1. Not on the barrel.
- `apps/engine/src/desktop/company-brief/schema.ts` — `DESKTOP_COMPANY_BRIEF_SCHEMA_SQL`.
- `apps/engine/src/desktop/company-brief/{revision,ground,model,brain,service,router,runtime}.ts` — revision, grounding, exact model pair, Brain adapter, durable service, unmounted router, store init.
- `apps/engine/src/desktop/company-brief/service.test.ts` — authored regressions, not run.
- `apps/ui/lib/desktop/server/company-brief/{model,model.test,client,revision,review-state,review-state.test}.ts` — explicit model choice, engine client, shared revision, draft reducer.
- `apps/ui/components/desktop/foreman/company-brief/DesktopCompanyBriefReview.tsx` — review panel. No mount fetch.

## Public contract and adapters

`DESKTOP_COMPANY_BRIEF_CONTRACT_VERSION = 1`.

Synthesize input binds `workspaceId`, `chatId`, `requestId`, `sourceRevision` (SHA-256 of `companyBriefCanonicalSnapshot(snapshot)`), `model` (`connectionId`, `provider`, `model`, `source`, `agentId`), and `snapshot: DesktopForemanDiscoveryRun`. `snapshot.chat` must equal the workspace and chat. `sourceRevision` must equal the hash. `status: 'running'` is refused.

`openDesktopCompanyBriefModel` / `confirmExplicitCompanyBriefModel` open that connection and model only when `isUsable` and the provider is `openai`, `anthropic`, `google`, or `openrouter`. Workspace source must equal `readBoxDefault`. Coworker source must equal `getAgent(agentId).config`. Conversation source returns false. `maxRetries: 0`. No `DEFAULT_PROVIDER_MODEL`, no `rerun` / `claude` / `codex`.

`explicitCompanyBriefModel` (UI) reads `readDesktopModelState`. A conversation pair that is not the workspace or coworker pair returns `conversation_model_unverified` and must not be sent.

`bindDesktopCompanyBriefBrain` calls `readPage`, `listProposals`, and `propose`. It does not call `decideProposal`, `save`, or `seedBrain`.

Attempts: `pending`, `accepted`, `dismissed`, `cancelled`, `stopped`, `failed`, `handed`, `skipped`, `stale`. Same `requestId` returns the stored row and does not call the model. `initialize` moves `pending` to `stopped`. `read` never synthesizes.

## Root mount fragments

Do not apply these in this worktree.

`packages/contracts/src/index.ts`, next to the foreman export:

```ts
export * from './desktop-company-brief.js'
```

`apps/engine/src/http/server.ts`, inside `if (desktopApp())`, after the proposals route:

```ts
import { createDesktopCompanyBriefRouter } from '../desktop/company-brief/router.js'
import { getCompanyBriefService } from '../desktop/company-brief/runtime.js'

api.route('/desktop/company-brief', createDesktopCompanyBriefRouter(getCompanyBriefService))
```

`apps/engine/src/datadir/migrations.ts`, next version after 5:

```ts
import { initializeDesktopCompanyBriefStore } from '../desktop/company-brief/runtime.js'

{
    version: 6,
    id: 'desktop-company-brief',
    up: async () => {
        if (!desktopApp()) return
        await initializeDesktopCompanyBriefStore()
    },
}
```

`initializeDesktopCompanyBriefStore` creates `company-brief-db/company-brief.db` under `dataDir()` (not inside `shared/`) and runs `DESKTOP_COMPANY_BRIEF_SCHEMA_SQL`. It does not call a model or propose a page. Call it once at desktop boot, after the Brain store can be pinned. A later call stops any `pending` row and does not synthesize.

Rebuild `@rerun/contracts` after the barrel line. Engine and UI imports of the new symbols resolve only then.

Board mount, in the existing discoveries overlay (do not edit `DesktopBoardDiscoveries` or `DesktopForemanColumn`):

```tsx
<DesktopCompanyBriefReview
    attempt={attempt}
    findings={snapshot.findings}
    draft={review.draft}
    selectedClaimIds={review.selectedClaimIds}
    notice={review.notice}
    onDraft={brief => setReview(editBriefDraft(review, brief))}
    onEdit={() => editCompanyBrief(runtime, { requestId, workspaceId, chatId, expectedDraftRevision, brief: review.draft })}
    onDismiss={() => dismissCompanyBrief(runtime, { requestId, workspaceId, chatId })}
    onRetry={() => retryCompanyBrief(runtime, nextInput)}
    onToggleClaim={id => setReview(toggleBriefClaim(review, id))}
    onHandoff={() => handoffCompanyBrief(runtime, handoffBody)}
/>
```

Place it in the board overlay, not in place of `DesktopForemanChatLayer`. The panel is `pointer-events-auto` at the bottom left; the overlay stays `pointer-events-none`, so the board and the chat stay usable. Do not copy `ui.draft` from the Foreman composer into the brief draft. Call `observeCompanyBrief` when the open chat or discovery revision changes (`active: false` when the chat closes). That is what makes a delayed model reply `stale`. There is no mount effect and no poll in this package.

## Supported / dependent / unsupported

| | Supported here | Dependent on root | Unsupported |
| --- | --- | --- | --- |
| Snapshot input | `DesktopForemanDiscoveryRun` version 1 | Rebind if A publishes another contract | A second discovery schema; running a collector |
| Model | Exact usable `openai` / `anthropic` / `google` / `openrouter` pair | Barrel export, route mount, boot init | Env model, Rerun/claude/codex, fallback ladder, conversation-only override |
| Grounding | Claims whose tags are on snapshot findings; other claims become unknowns | — | Search, registry, LinkedIn, DNS, stack, catalog, unless that finding is already in the snapshot |
| Review | Edit, dismiss, retry; draft kept when the result is stale | Mount the panel and call `observe` | Auto-accept; replacing the board or chat |
| Brain | `propose` with current `baseHash`; duplicate reused; hash conflict rejected | Existing Brain proposal routes stay the accept/dismiss UI | `seedBrain`, `decideProposal`, a second page store |
| Restart | `pending` becomes `stopped`; read does not synthesize | Boot calls `initializeDesktopCompanyBriefStore` | Resuming a model call after restart |

## Persistence and recovery

Tables: `desktop_company_briefs`, `desktop_company_brief_context`, `desktop_company_brief_handoffs`.

- Lost acknowledgement: the same `requestId` or `handoffRequestId` returns the stored row. `modelCalled` is false. `propose` is not called again.
- A crash after `propose` and before the handoff row is finished leaves `{"pending":true}`. Replaying that id returns 409 and does not propose again. A new id sees the open proposal and rejects with `open_proposal`.
- Cancel aborts the in-flight call. A late reply is stored only while status is still `pending`.
- Edit uses `expectedDraftRevision`. A mismatch is 409 and does not change the draft. A context revision change does not apply the delayed brief (`review-state.applyBriefAttempt`).
- Dismiss does not dismiss Brain proposals. Status `handed` cannot be dismissed here; the existing proposal UI still owns accept and dismiss.
- An edited draft is not proposed unless `includeDraft` is true, and then every source tag in the draft must be on the snapshot.

## Authored regressions (not run)

`apps/engine/src/desktop/company-brief/service.test.ts`

- Grounded overview claim keeps `[site]` and the attribution URL; a registry claim becomes an unknown; legal name stays empty; a second synthesize does not call the model; `propose` is not called.
- Same request id on another chat is 409; the other chat reads null.
- Read and a repeated synthesize do not call the model.
- Observe with a new source revision drops the delayed reply (`stale`, no brief).
- `initialize` during a call stops the row; the same id does not call the model again.
- Abort cancels the row and ignores the late text.
- Edit, stale edit, dismiss, and retry keep the draft and do not propose.
- Wrong page hash, missing page, and a replayed handoff do not overwrite page content or call `propose` again. A matching hash proposes once.
- Missing model, a running snapshot, and an empty snapshot do not call a model. Empty uses `Aucune source à synthétiser`.
- GET `/` does not synthesize.

`apps/ui/lib/desktop/server/company-brief/review-state.test.ts` — other chat, other revision, and a dirty draft are not replaced.

`apps/ui/lib/desktop/server/company-brief/model.test.ts` — workspace and coworker pairs are kept; `rerun` and a different conversation model are refused.

## Limits

- Desktop findings in version 1 are only `identity`, `audience`, `products`, `customers`, and `competitors`. Team, pricing, registry, stack, and reputation stay unknown unless a later snapshot actually contains a citable finding. The brief is not padded to 400 words.
- Only `site` is collected today (`apps/engine/src/desktop/foreman/discovery.ts`). This package does not add collectors.
- A conversation model that is not the saved coworker or workspace model is unverified and is not called.
- `initialize` during a live process stops `pending` rows. Root should call it at boot, not on a timer.
- Two concurrent synthesizes of a new request id are not serialized. The second insert can fail. Retries of a stored id stay read-only.
- Two concurrent handoffs of the same id: the loser gets the stored result or 409. It does not accept a proposal.
- Model text is not consent. Nothing in this package accepts a proposal or writes a Brain page.
- The raw model reply is not stored when it fails to parse.
- E11 and D8 are not checked.
