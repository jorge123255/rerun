# Round 37 F — original inferred-profile presentation and intake board preview

Source implementation and authored regression sources only. **No checks executed and no installed acceptance.** Assignment base: `e87edabffded9b56c67f98539a412e230959435c`; accepted C35 runtime reference: `81f1c62a7b9fb0ac1f44bbee77c21e0f4aa576f5`. Round36 handoffs were not integrated, modified or treated as accepted.

Implementation commit: `b5d8437f30ae5986a42fbc4f761cc2fac1d75e1c`.

E dependency: implementation `22ade7092c2b9950bbf1ecc15f7488bcf193071c`, handoff tip `5d16ee6d625896735d7210715da786544d85a4e1`, `DESKTOP_COMPANY_PROFILE_CONTRACT_VERSION = 1`.

## Original source/design mapping

Reviewed original fork `2a57fa6dd53311f763bfc9abde85997b7f7e5309` in the read-only `upstream-review-20261106` checkout. Historical pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` and accepted C35 were also read.

| Original | Owned port | Preserved behavior / Mac boundary |
|---|---|---|
| `lib/onboarding/intake.ts` | `lib/desktop/company-profile/preview.ts` | `intakePreviewPlan` and `intakeBoxes`: original industry divisions, company title, five-box ceiling, unique `intake-*` keys and zero coworker tiles. Projection returns null outside the active empty-workspace onboarding context or before an industry exists. |
| `components/foreman/intake/useForemanIntake.ts` | `use-desktop-company-profile.ts` and root C35 fragment | Latest-input race protection, 350 ms C35 debounce left in the accepted controller, Skip/manual precedence and early optional analysis. F itself never starts analysis on mount/restore; root arms optional ports only after a real edit/Next gesture. |
| `ForemanIntakeCard`, `IntakeCompanyStep`, `IntakeIndustryStep`, `IntakeChoiceStep`, `IntakeTextStep`, `IntakeField` | Existing C35 components, unchanged | Original questions, ordering, copy, Skip/Next, number/Enter keyboard behavior and responsive card remain canonical. F does not rebuild the accepted manual card. |
| `ForemanColumn.tsx`, `ForemanChatLayer.tsx` | Root mount beside the existing Foreman panel | Board remains visible beside chat. Hidden generated kickoff, accepted completion ID, discover-to-plan transition, ordinary chats and unrelated drafts remain untouched. |
| `builder/discoveries/DiscoveryStatusPill.tsx` | `DesktopCompanyProfileBoardPreview` and existing desktop pill | Original pending/found presentation above the tentative board. |
| `DiscoveryCard`, `DiscoveryStack`, `DiscoveryTeaser`, `BoardDiscoveries` | `DesktopCompanyProfileFindings`, `DesktopCompanyProfileStatus` | Original `Found you`, `What you sell`, `Who you sell to` and source/citation style, compact single-finding layout and bounded short-panel scrolling. |
| `DesktopPlanBoardPreview` and desktop `plan-scene.ts` | Pure board preview | Existing `findRadialRect` order, 900 ms Box drawing/420 ms cascade, ghost settled state and exact desktop geometry. No actual Box/coworker create, rename, reorder, move, selection, recenter or camera write. |
| `DesktopCompanyBriefReview` | Evidence details | Sourced name/description/offering/audience/industry with exact passage, attribution URL, origin and confidence where supplied by E. |

Corrections return through E/root’s `Review original question` callback. F never edits C35 answers, completion receipts or a second client profile store.

## Published dependent contract revisions

- `packages/contracts/src/desktop-company-profile.ts`, E `22ade7092c2b9950bbf1ecc15f7488bcf193071c`, version 1:
  - `desktopCompanyProfileViewSchema`: current `decisionIdentity` / `enrichmentIdentity`, attempts, merged sourced profile and known-name outcome.
  - `desktopCompanyProfileIdentitySchema`: workspace/chat, `draftRevision`, `inputDigest`.
  - `desktopCompanyProfileDecideInputSchema`, `desktopCompanyProfileEnrichInputSchema`, `desktopCompanyProfileCancelInputSchema`: explicit `decide`, `enrich`, `cancel` operations.
  - `desktopCompanyProfileAttemptSchema`: pending/succeeded/unavailable/cancelled/stale/error, source progress, exact evidence and `modelCalled`.
  - `desktopCompanyProfileProjectionSchema`: company URL/name/description/offering/audience/industry/role/first name, origin, evidence and industry confidence.
  - `desktopCompanyProfileCorrectionSchema`: original-question prompt with `preserveOriginalQuestion: true`.
- Existing C35 intake v1, company discovery v1, company brief/model ref v2, Foreman chat identity and template categories remain unchanged.

The F base does not contain E’s contract barrel export. Root must integrate E before typechecking or mounting F.

## Concrete adapters

### `createDesktopCompanyProfileClient()`

Authenticated loopback `/api/desktop/foreman/company-profile`:

- `read(chat, signal)`: observational GET, 20 s bound.
- `decide({requestId,identity}, signal)`: explicit POST `action:'decide'`, 45 s bound.
- `enrich({requestId,identity,collect}, signal)`: explicit POST `action:'enrich'`, 125 s bound.
- `cancel({requestId,chat}, signal)`: explicit POST `action:'cancel'`, 30 s bound.

All responses use E’s schemas. HTTP refusal status remains distinct from unknown transport failure. Creating the client has no effects.

### `useDesktopCompanyProfile({chat,client,active,draftRevision})`

Returns `{view,loading,error,pending,read,decide,enrich,stop,invalidate}`.

- Mount/restore only reads. Pending attempts poll every 2 s without starting a new request.
- Explicit `decide()` / `enrich(collect)` uses the current E identity and returns the acknowledged E attempt for C35’s optional ports.
- Pending/succeeded identities replay; terminal unavailable/cancelled/stale/error retries receive a fresh request ID. An unknown transport outcome retains the original request ID for exact recovery.
- Scope, draft revision, current identity, request ID and response identity are rechecked after awaits.
- Close/workspace change aborts only owned local requests; committed server work is not cancelled or repeated.
- `stop(kind?)` cancels only current owned attempts. Root Stop also calls it. Shutdown listeners abort local work; cancelled Quit permits observational rereads only.

### Pure projection and components

- `companyProfilePreviewPlan(scope,{industry,companyName})`: no side effects, no storage, no board mutation.
- `DesktopCompanyProfile`: optional `controllerRef` for C35 and `onCorrection` for original-question focus.
- `DesktopCompanyProfileBoardPreview`: pure overlay and compact presentation.
- `DesktopCompanyProfileStatus`: progress, unavailable, cancelled, stale, error, Stop, Retry and correction.
- `DesktopCompanyProfileFindings`: sourced fields and exact evidence.

## Exact root activation fragments

### 1. Contracts barrel and migration

Append to root-owned `packages/contracts/src/index.ts`:

```ts
export * from './desktop-company-profile.js'
```

Current C35 migration is 30. Allocate the next actually free version (31 if still free), id `company-profile-derived-attempts`, without renumbering any existing step. Apply `DESKTOP_COMPANY_PROFILE_SCHEMA_SQL` before routes; production binding uses `schemaReady: true`.

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

Standalone fixtures alone may call `ensureDesktopCompanyProfileSchema`.

### 2. Engine and authenticated UI routes

Root-owned `apps/engine/src/http/server.ts`, beside company brief with existing API authentication:

```ts
import { createDesktopCompanyProfileRouter } from '../desktop/company-profile/router.js'

api.route('/desktop/company-profile', createDesktopCompanyProfileRouter())
```

Create root-owned `apps/ui/app/api/desktop/foreman/company-profile/route.ts` with E’s exact route from `docs/desktop-round37-e-handoff.md`. Its operation envelope is:

```ts
const bodySchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('decide'), input: desktopCompanyProfileDecideInputSchema }),
    z.strictObject({ action: z.literal('enrich'), input: desktopCompanyProfileEnrichInputSchema }),
    z.strictObject({ action: z.literal('cancel'), input: desktopCompanyProfileCancelInputSchema }),
])
```

Use `desktopRoute`, `readDesktopJson(request, 32 * 1024)`, `assertDesktopWorkspaceAdmission(runtime)`, and `desktopCompanyProfile(runtime, app)`. GET parses `workspaceId`/`chatId` with `foremanChatRefSchema` and returns `read(chat)` with `cache-control: no-store`. POST maps `DesktopCompanyProfileError` to 404 for `not_found`, 503 for `storage`, and 409 otherwise. Do not accept a fabricated `runId`, `discoveryId` or tool-run binding.

### 3. C35 authority, save, Stop and shutdown

Bind the optional E authorities without changing C35 completion:

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

Before each C35 revision advances, E verifies automatic hints and cancels older work. On the existing Foreman Stop path and before workspace switches:

```ts
await desktopCompanyProfile(runtime, app).cancelChat(chat)
```

In native shutdown, only close an already-created binding:

```ts
await shutdownDesktopCompanyProfile(runtime)
```

Normal initialization alone calls `profile.reconcile()`. Startup/read/restore never starts collection or inference.

### 4. Connected Foreman render/controller mount

In root-owned `ConnectedForeman`, retain the accepted C35 controller but arm optional analysis only after a user gesture. This prevents a restored draft from starting work.

Declare the optional ports before constructing the C35 controller. `profileArmed` starts false on every mount and resets on workspace/chat changes.

```tsx
const companyProfileRef = useRef<DesktopCompanyProfileController | null>(null)
const [profileArmed, setProfileArmed] = useState(false)
const intakeClientPorts = useMemo(() => createDesktopForemanIntakeClient(), [])
const intakePorts = useMemo(() => ({
    ...intakeClientPorts,
    ...(profileArmed ? {
        decideIndustry: async (_input: string, _signal?: AbortSignal) => {
            const attempt = await companyProfileRef.current?.decide()
            return attempt?.outcome?.status === 'succeeded'
                ? attempt.outcome.decision?.industry ?? null
                : null
        },
        analyzeSite: async (_url: string, _signal?: AbortSignal) => {
            const attempt = await companyProfileRef.current?.enrich(true)
            return {
                state: attempt?.outcome?.status === 'succeeded' ? 'ready' as const : 'unavailable' as const,
            }
        },
    } : {}),
}), [intakeClientPorts, profileArmed])
const baseIntake = useDesktopForemanIntake({
    chat: initial.chat,
    ports: intakePorts,
    active: !!props.controlledOpen && !props.hidden,
})
const intake = useMemo(() => ({
    ...baseIntake,
    set: patch => {
        if ('companyUrl' in patch || 'industryLabel' in patch) setProfileArmed(true)
        baseIntake.set(patch)
    },
    next: () => { setProfileArmed(true); baseIntake.next() },
    skipWebsite: () => {
        setProfileArmed(false)
        void companyProfileRef.current?.stop()
        baseIntake.skipWebsite()
    },
    chooseIndustry: industry => {
        setProfileArmed(false)
        void companyProfileRef.current?.stop()
        baseIntake.chooseIndustry(industry)
    },
}), [baseIntake])
const compact = useMediaQuery('(max-width: 767px)')
```

Pass the canonical empty-board identity from `DesktopApp` through `DesktopForemanPanelProps`:

```tsx
const emptyWorkspace = agents.length === 0 && boardState.board.spaces.length === 0
<DesktopForemanPanel {...panelProps} emptyWorkspace={emptyWorkspace} />
```

Then mount beside the existing Foreman panel/discoveries. Both the canonical empty board and the intake-onboarding context are required.

```tsx
<DesktopCompanyProfile
    chat={state.chat}
    active={intakeOpen && !!props.controlledOpen && !props.hidden}
    emptyWorkspace={props.emptyWorkspace && initial.messages.length === 0}
    onboarding={intakeOpen}
    draftRevision={intake.revision}
    compact={compact}
    controllerRef={companyProfileRef}
    onCorrection={correction => {
        intake.goTo(correction.field === 'industry' ? intake.steps.indexOf('industry') : 0)
        setFocusRequest(`company-profile-correction:${correction.field}`)
    }}
/>
```

On the existing Foreman Stop control, call both the canonical Foreman stop and `companyProfileRef.current?.stop()`. Close only makes the overlay inactive; correction uses the existing intake step and focus return. No C35 completion, kickoff, board command or chat mutation is added.

## Implemented / dependent / unsupported matrix

| Area | Owned source | Dependency / unsupported |
|---|---|---|
| Original intake preview | Original Boxes, title, keys, geometry and no coworker tiles | Root supplies the actual empty-workspace onboarding context |
| Optional inference | Exact E identities/outcomes and explicit controller | E route/service/model; never started by F mount or restore |
| Manual fallback | Skip/manual choice remains usable during pending/unavailable/error | Accepted C35 controller and receipt |
| Sourced profile | Name/description/offering/audience/industry, confidence, exact citations | Evidence supplied by E; unsupported fields stay absent |
| Late responses | Scope/draft/input/request fences | Root advances C35 revision and calls E cancellation before saves |
| Stop/Close/Quit | Owned request cleanup and explicit cancellation | Root’s Foreman Stop, workspace switch and native shutdown wiring |
| Board/camera | Pure overlay only | Root owns actual board and camera; no recenter or layout writes |
| Existing chats/teams | No effect | Ordinary saved chats stay on ordinary chat, never the decorative preview |
| Verification | Real component/pure-preview regression source | Root runs all static checks, packaging, narrow/short Mac and restart QA |
| Paid/public enrichment | Not added | No credentialed collectors, provider fallback, public listener or upload |

## Authored regressions — all unrun

- `lib/desktop/company-profile/client.test.ts`: no-effect construction, exact GET/POST/cancel envelopes and transport/refusal distinction.
- `preview.test.ts`: original Boxes/geometry, no mutation, no-industry refusal, context gating, request identity and two scopes.
- `use-desktop-company-profile.test.tsx`: restored-state inactivity, exact explicit identities, unknown-ACK replay, changed-URL/revision fencing and Stop without new analysis.
- `DesktopCompanyProfileBoardPreview.test.tsx`: manual fallback, original geometry/empty agent scene, sourced fields/citations, pending/cancelled and compact presentation.
- `DesktopCompanyProfile.test.tsx`: restored state, explicit controller/correction callbacks and Close without committed-work cancellation or new analysis.

No tests, typechecks, lint, builds, installs, servers, fixtures, provider/network calls, Docker, browser/native UI, screenshots, microphone, Keychain or restart checks were executed. Existing installed Next.js `use client` guidance was read; no dependency was installed.

## Changed files

- `apps/ui/components/desktop/foreman/company-profile/DesktopCompanyProfile.tsx`
- `apps/ui/components/desktop/foreman/company-profile/DesktopCompanyProfileBoardPreview.tsx`
- `apps/ui/components/desktop/foreman/company-profile/DesktopCompanyProfileFindings.tsx`
- `apps/ui/components/desktop/foreman/company-profile/DesktopCompanyProfileStatus.tsx`
- `apps/ui/components/desktop/foreman/company-profile/index.ts`
- `apps/ui/components/desktop/foreman/company-profile/DesktopCompanyProfile.test.tsx`
- `apps/ui/components/desktop/foreman/company-profile/DesktopCompanyProfileBoardPreview.test.tsx`
- `apps/ui/lib/desktop/company-profile/client.ts`
- `apps/ui/lib/desktop/company-profile/preview.ts`
- `apps/ui/lib/desktop/company-profile/use-desktop-company-profile.ts`
- `apps/ui/lib/desktop/company-profile/index.ts`
- `apps/ui/lib/desktop/company-profile/test-fixtures.ts`
- `apps/ui/lib/desktop/company-profile/client.test.ts`
- `apps/ui/lib/desktop/company-profile/preview.test.ts`
- `apps/ui/lib/desktop/company-profile/use-desktop-company-profile.test.tsx`
- `docs/desktop-round37-f-handoff.md`

The implementation SHA is recorded above. Final handoff-tip SHA and clean/dirty status are reported in the final response rather than chased self-referentially in this document. Root owns review, all fixes, tests, packaging and board/full-restart acceptance.
