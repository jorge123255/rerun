# Round 37 — Agent E handoff: optional company inference and sourced profile runtime

Source package only. **E11 is not installed or accepted.** No tests, typechecks, lint, builds, installs, servers, fixtures, provider/network calls, Docker, browser/native UI, microphone, Keychain, restart checks, installed-preview access, push, merge, publish or deployment were run from this lane. Root owns review, repairs, every execution check, packaging and Mac/full-restart acceptance.

- **Branch:** `desktop/round37-company-profile-runtime`
- **Prepared base verified clean before editing:** `e87edabffded9b56c67f98539a412e230959435c` (accepted runtime `81f1c62a7b9fb0ac1f44bbee77c21e0f4aa576f5`)
- **Implementation commits:** `93068a19d0c47022e95d96bba2069ab20358f70a`, then shutdown-only binding fix `22ade7092c2b9950bbf1ecc15f7488bcf193071c`
- **Implementation SHA for integration:** `22ade7092c2b9950bbf1ecc15f7488bcf193071c`
- **Worktree:** `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round37-company-profile-runtime`
- **Final tip:** recorded in the final agent reply, not chased self-referentially here
- **Round36:** no Round36 handoff was integrated, modified or treated as accepted

## Exact original source / design mapping

Reviewed original fork: `2a57fa6dd53311f763bfc9abde85997b7f7e5309` in the read-only `upstream-review-20261106` checkout. Historical acceptance/design pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` and the accepted C35 integration at `81f1c62` were also read.

| Original | Round37 port | Preserved behavior / intentional Mac boundary |
|---|---|---|
| `apps/ui/lib/company/decide-industry.ts` | `apps/engine/src/desktop/company-profile/{bounded,classifier,model}.ts` | One typed industry and confidence, 0.5 abstention floor, 2s default deadline, null/unavailable rather than a guess. Uses the exact explicitly selected no-tool model through the existing isolated one-shot adapter. Does **not** read `OPENROUTER_API_KEY`, call the alpha decisions endpoint, borrow ChatGPT or fall back to another model. |
| `apps/ui/lib/company/analyze.ts` | `apps/engine/src/desktop/company-profile/profile.ts` | Name, industry, description, offering and audience from sourced evidence. Every model field must name an evidence item and quote an exact substring of that item; unsupported fields become null. |
| `apps/ui/lib/company/profile.ts` | server `service.ts`, `store.ts`, `evidence.ts` | Optional read/analyze behavior with replayable derived attempts. Durable replay replaces the original 15-minute process cache. A derived attempt is never a canonical company profile or a new completion authority. |
| `apps/ui/lib/company/explore/discoveries.server.ts` | `evidence.ts`, `collector.ts`, `projection.ts` | Reuses accepted source/provenance identities and preserves exact passages. Preview collection calls the accepted `runCompanyCollectors`, `confinedCompanyReader` and `confinedCompanyDns`; it does not create another research runtime. |
| `foreman-intake.actions.ts` manual > full profile > fast decision | `projection.ts`, `service.ts` | Manual industry always wins; then sourced full inference; then the accepted/fast decision. `industryLabel` remains the offering fallback only when no sourced offering exists. |
| `useForemanIntake.ts` latest-input race, Skip and typed-site analysis | `identity.ts`, `service.ts` | Workspace/chat, draft revision and input digest fence edited URLs, newer drafts, manual changes, Skip and workspace switches. Reads and restore never start inference. |
| Original account/profile first name | `actor.ts` | Reads only explicit local `desktop_profile.display_name` through the trusted actor port. Generic Local User/local-user/User/owner/admin and email-shaped values are unavailable. No OS username, email or website-author inference. |
| C35 one acknowledged completion | `intake-hints.ts` and root fragments below | Does not mutate C35 drafts, answers, completion identity, receipts or kickoff. Automatic hints are accepted only when they match the current trusted inference/local actor exactly. |

## Published contract for F

New `packages/contracts/src/desktop-company-profile.ts`, `DESKTOP_COMPANY_PROFILE_CONTRACT_VERSION = 1`.

Public schemas/types include:

- `desktopCompanyProfileIdentitySchema`: exact `{ chat: { workspaceId, chatId }, draftRevision, inputDigest }`.
- `desktopCompanyProfileViewSchema`: current decision/enrichment identities, latest attempts, merged profile projection and known-name outcome.
- `desktopCompanyProfileAttemptSchema`: durable request/kind/identity, progress, typed outcome, evidence, `modelCalled`, timestamps.
- `desktopCompanyIndustryDecisionSchema`: category, confidence and `manual | accepted | inference` source.
- `desktopCompanyProfileProgressSchema`: queued, site reading, evidence analysis, projection and source-level progress.
- `desktopCompanyProfileProjectionSchema`: company URL, name, description, offering, audience, industry, role and first name, each with origin and exact evidence where applicable.
- `desktopCompanyProfileOutcomeSchema`: succeeded, unavailable (missing configuration, low confidence, invalid input, missing evidence/model, timeout), cancelled, stale and error outcomes. Corrections carry the original question and `preserveOriginalQuestion: true`.
- `desktopCompanyProfileDecideInputSchema`, `desktopCompanyProfileEnrichInputSchema`, `desktopCompanyProfileCancelInputSchema`.
- Engine-only selected-model input/outcome schemas and exact inference/evidence schemas.
- `desktopCompanyProfileCanonicalContextSchema`: C35 session + acknowledged answers + canonical discovery snapshot. This is a read projection, not another stored profile.

F flow: GET the view; use the supplied current identity for an explicit decide/enrich request; render source progress/outcome/correction; save `decidedIndustry` only from a succeeded inference attempt for the same `baseRevision`; do not start anything on mount/restore. Manual industry remains authoritative. No UI package was assigned or edited here.

Dependent existing contracts remain unchanged: C35 intake v1, company discovery v1, company brief/model ref v2, Foreman chat identity and template categories.

## Implementation inventory

### Contract

- `packages/contracts/src/desktop-company-profile.ts`

### Engine inference package

- `bounded.ts`: exact-model confirmation, deadline/cancellation and safe JSON parsing.
- `classifier.ts`: bounded typed industry decision and confidence floor.
- `profile.ts`: sourced full-profile inference and exact evidence-quote validation.
- `model.ts`: adapter over the accepted isolated no-tool `CompanyBriefModel` path.
- `router.ts`: desktop-only authenticated-loopback mountable `/decide` and `/enrich` operations with bounded JSON bodies.
- `index.ts`
- `classifier.test.ts`, `profile.test.ts`: authored, unrun regressions.

### Desktop server package

- `actor.ts`: trusted local-profile first-name adapter.
- `binding.ts`: canonical C35/discovery/selected-model wiring and shutdown-only binding lookup.
- `client.ts`: bounded authenticated engine HTTP client.
- `collector.ts`: confined preview evidence collection without a Foreman run ID.
- `errors.ts`, `identity.ts`: typed failures, input digests, stable request identity and request fingerprints.
- `evidence.ts`: exact passages/provenance from accepted collector payloads and snapshots.
- `projection.ts`: manual/accepted/inference/discovery precedence.
- `schema.ts`, `store.ts`: additive derived-attempt store; memory and SQLite adapters, replay and pending-only settlement.
- `service.ts`: complete admission, progress, inference, projection, cancellation, Stop, workspace fencing, Quit and restart lifecycle.
- `intake-hints.ts`: C35 automatic-hint verification.
- `index.ts`
- `actor.test.ts`, `projection.test.ts`, `runtime.test.ts`, `store.test.ts`, `intake-hints.test.ts`: authored, unrun regressions.

No manifests, lockfiles, provider enums, contracts barrel, DesktopApp/Settings/composer/board files, central routers, supervisor, preload/IPC, canonical migration ladder or Round36 files were edited.

## Runtime semantics

1. **Admission/replay:** request fingerprint binds kind, workspace/chat, draft revision, input digest and collect flag. Same request + fingerprint replays the persisted attempt. Request reuse for another identity is a conflict. A succeeded attempt for the same current identity also prevents a fresh duplicate request after reload.
2. **Manual precedence:** a current manual/accepted explicit industry settles without a model call. Full profile inference never overwrites it. C35 accepted receipts remain immutable.
3. **Evidence:** preview reads use only public confined DNS/HTTP collectors. No cookies, browser profile, ambient private data, paid search/LinkedIn/Google, second research service or active Foreman tool-run identity is used.
4. **Model:** decision and profile authorities are explicitly bound to the current exact conversation model pair in `binding.ts`. The engine rechecks that pair through the accepted model adapter before and after the one-shot call. There is no provider/model ladder and no tool grant. Current Codex-only connection state is unchanged.
5. **Progress:** source and model progress are persisted outside authority/network waits. No database transaction encompasses a collector, model, engine or workspace-authority wait.
6. **Late results:** identity is revalidated after awaits and before settlement. Pending-only SQL settlement means Cancel/Stop wins over a late answer. Cancellation is immediately observable; actual adapter work is aborted and Quit drains admitted work.
7. **Restart:** first binding reconciliation marks abandoned pending attempts `error/interrupted`; it does not call a collector or model. Saved success remains readable. Reads are observational apart from trusted local-profile name lookup.
8. **Effects:** no C35 answer mutation, Foreman send, coworker, Box, plan approval, Brain page, public share, provider connection or external listener is created by this package.

## Root activation fragments

### 1. Contracts barrel

Append to root-owned `packages/contracts/src/index.ts`:

```ts
export * from './desktop-company-profile.js'
```

### 2. Additive desktop app-database migration

Current C35 migration is 30. Allocate the next actually free desktop version (31 if still free); do not renumber or replace any existing step. Use id `company-profile-derived-attempts` and the exact SQL exported as `DESKTOP_COMPANY_PROFILE_SCHEMA_SQL`:

```sql
CREATE TABLE IF NOT EXISTS desktop_company_profile_attempts (
    request_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('decide','enrich')),
    fingerprint TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_company_profile_attempts_chat
    ON desktop_company_profile_attempts(workspace_id,chat_id,kind,updated_at);
```

The production binding uses `schemaReady: true`; the migration must run before routes use it. Standalone fixtures alone may call `ensureDesktopCompanyProfileSchema`.

### 3. Engine route mount

Root-owned `apps/engine/src/http/server.ts`:

```ts
import { createDesktopCompanyProfileRouter } from '../desktop/company-profile/router.js'

// Inside if (desktopApp()), beside company-brief. Existing api auth applies.
api.route('/desktop/company-profile', createDesktopCompanyProfileRouter())
```

The router is stateless; no startup model read or provider connection occurs. Existing engine desktop policy and bearer authentication remain the boundary.

### 4. Authenticated UI API route

Create root-owned `apps/ui/app/api/desktop/foreman/company-profile/route.ts` using the existing `desktopRoute` wrapper and `readDesktopJson` limit:

```ts
import { z } from 'zod'
import {
  desktopCompanyProfileCancelInputSchema,
  desktopCompanyProfileDecideInputSchema,
  desktopCompanyProfileEnrichInputSchema,
  foremanChatRefSchema,
} from '@rerun/contracts'
import { desktopRoute } from '@/lib/desktop/server/http'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { desktopCompanyProfile, DesktopCompanyProfileError } from '@/lib/desktop/server/company-profile'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

export const runtime = 'nodejs'
const bodySchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('decide'), input: desktopCompanyProfileDecideInputSchema }),
  z.strictObject({ action: z.literal('enrich'), input: desktopCompanyProfileEnrichInputSchema }),
  z.strictObject({ action: z.literal('cancel'), input: desktopCompanyProfileCancelInputSchema }),
])

export async function GET(request: Request) {
  return desktopRoute(request, async runtime => {
    const query = new URL(request.url).searchParams
    const chat = foremanChatRefSchema.parse({ workspaceId: query.get('workspaceId'), chatId: query.get('chatId') })
    const app = await desktopForeman(runtime)
    return Response.json(await desktopCompanyProfile(runtime, app).read(chat), { headers: { 'cache-control': 'no-store' } })
  })
}

export async function POST(request: Request) {
  return desktopRoute(request, async runtime => {
    const parsed = bodySchema.safeParse(await readDesktopJson(request, 32 * 1024))
    if (!parsed.success) throw new DesktopHttpError(400, 'This company profile request was not understood.')
    await assertDesktopWorkspaceAdmission(runtime)
    const app = await desktopForeman(runtime)
    const profile = desktopCompanyProfile(runtime, app)
    try {
      if (parsed.data.action === 'decide') return Response.json(await profile.decide(parsed.data.input, { signal: request.signal }))
      if (parsed.data.action === 'enrich') return Response.json(await profile.enrich(parsed.data.input, { signal: request.signal }))
      return Response.json(await profile.cancel(parsed.data.input))
    } catch (error) {
      if (error instanceof DesktopCompanyProfileError) {
        const status = error.code === 'not_found' ? 404 : error.code === 'storage' ? 503 : 409
        throw new DesktopHttpError(status, error.message)
      }
      throw error
    }
  })
}
```

GET/POST ownership and current-workspace checks are repeated by the concrete binding. No preview request supplies or fabricates `runId`, `discoveryId` or a Foreman tool-run binding.

### 5. C35 optional authority binding

Root-owned `apps/ui/lib/desktop/server/foreman/intake.ts`: accept the current chat when creating the service and bind the new profile adapter instead of the three null ports. Keep the existing completion authority and send journal unchanged.

```ts
const profile = chat ? desktopCompanyProfile(runtime, app) : null
const service = createDesktopForemanIntakeService({
  store: createSqliteDesktopForemanIntakeStore(app.db, { schemaReady: true }),
  completion,
  industry: profile && chat ? { decide: () => profile.decideIndustry(chat) } : null,
  site: profile && chat ? { analyze: () => { void profile.analyzeSite(chat).catch(() => {}) } } : null,
  knownName: profile ? { readKnownFirstName: current => profile.resolveKnownFirstName(current) } : null,
})
```

Pass the parsed chat from the existing intake route at each `createDesktopForemanIntakeBinding(runtime, app)` call. Preserve existing tests and one-completion behavior. The fire-and-forget site call is explicitly attempted only by the existing user-driven intake handler, never by read/hydrate.

### 6. C35 save and Stop controller

Replace the current blanket rejection of every non-null `decidedIndustry` / `knownFirstName` in root-owned `apps/ui/app/api/desktop/foreman/intake/route.ts`:

```ts
const profile = desktopCompanyProfile(runtime, app)
await assertDesktopCompanyProfileIntakeHints(profile, input.input)
await profile.cancelChat(chat) // invalidates older pending work before the revision advances
return Response.json(await service.save(input.input))
```

Manual values continue through the existing C35 schema. The helper accepts automatic values only for the exact current trusted inference and actor. On the existing Foreman Stop path, also call:

```ts
await desktopCompanyProfile(runtime, app).cancelChat(chat)
```

Apply the same cancellation on the old chat before a workspace switch. Revision/digest checks remain the second fence even if cancellation cannot be confirmed.

### 7. Quit / shutdown

In the existing native preflight/drain path, close only an already-created profile binding:

```ts
await shutdownDesktopCompanyProfile(runtime)
```

This never creates a binding during shutdown. It aborts and drains admitted work, preserves terminal attempts and leaves saved success readable on the next launch. Root should invoke `profile.reconcile()` only through normal binding initialization; startup reads never trigger collection or inference.

## Implemented / dependent / unsupported matrix

| Capability | Status |
|---|---|
| Typed industry confidence, source progress, profile projection, corrections, unavailable/cancelled/error outcomes | **Implemented in source** |
| Exact workspace/chat/draft-revision/input-digest identity and request replay | **Implemented in source** |
| Bounded configured classifier, abstention, cancellation, malformed-response refusal | **Implemented in source** |
| Confined preview collection and canonical snapshot evidence with exact passages/provenance | **Implemented in source** |
| Manual > full inference > fast/accepted precedence; C35 immutable receipts untouched | **Implemented in source** |
| Edited URL, newer draft, manual industry change, Skip, Stop, workspace switch, Quit and late-result fencing | **Implemented in source** |
| Restart reconciliation and saved-success reads without duplicate inference | **Implemented in source** |
| Trusted first name from explicit local profile only | **Implemented in source** |
| F UI, contracts barrel, API mounts, migration application and C35/Stop/Quit activation | **Dependent on root fragments above** |
| All tests/typechecks/lint/build/package/live provider/Mac/restart acceptance | **Dependent on root; nothing executed here** |
| Paid/credentialed collectors, browser bypass, second research runtime, public enrichment | **Unsupported by design** |
| New provider registration, credential borrowing, ambient account inference, model fallback | **Unsupported by design** |
| Automatic C35 completion, Foreman send, coworker/Box/plan/page/share effects | **Unsupported by design** |

## Authored-but-unrun regressions

- Engine classifier: success, low confidence, missing exact configuration, deadline, cancellation, malformed/unknown category.
- Engine profile: exact evidence/provenance, missing-quote/instruction rejection, low-confidence industry with sourced fields retained, malformed response.
- Server projection: manual precedence and accepted discovery/fast-decision fallback.
- Server runtime: replay, manual short-circuit, missing model, edited URL, newer revision, manual change, Skip, late answer, Stop/chat cancellation, Quit, workspace switch, restart, request conflict, enrichment replay and observational name resolution.
- SQLite store: cold reopen of terminal state and refusal of late settlement after cancellation.
- Actor and C35 hints: generic/email-shaped names rejected; forged/mismatched automatic hints rejected.

## Honest limitations

- The fast classifier uses structured JSON through the exact selected no-tool model, not upstream's OpenRouter alpha decisions endpoint. Confidence is model-reported and thresholded, not independently calibrated. This avoids any new credential or provider dependency.
- Evidence quotations are verified exactly; summarized field quality still requires root's offline and live acceptance. Unsupported fields remain null rather than being filled from general knowledge.
- Preview evidence is a derived attempt, not silently promoted into C35 answers or an accepted discovery receipt. Credentialed discovery sources remain unavailable.
- `desktop_profile.display_name` is the only local actor field used. If it is generic or absent, the original first-name question remains necessary.
- Root must run static checks and repair any findings directly. No claim of compile success, runtime success, installed acceptance or checklist completion is made.
