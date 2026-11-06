# RD40 E2 search credential-revision receipt handoff

**Kind:** narrow source repair — **not** RD40 complete, **not** accepted, **not** tested.  
**Branch:** `desktop/round38-master-completion`  
**Frozen base:** `6f6ad959a09abaf1947950b6f82413c94407e22a`  
**Original pin:** `2a57fa6dd53311f763bfc9abde85997b7f7e5309` (read-only RD40 audit prior)  
**Parent tip before this commit:** `81d3109489cabe7397763194f8adad44522d8199`  
**Impl SHA:** `aed685747b0ee88fad99e90bf870650be997d990`

## Defect (verified)

Rotated/stale search credential errors inside `adapter.search` ran with `providerFailure=true`, so `createDesktopWebSearchService` mapped them to generic **Search provider failed.** Fingerprint/run/grant/revision binding existed; classification did not distinguish pre-effect capability change from provider transport failure or in-flight uncertainty.

## Change

| Path | Role |
|---|---|
| `apps/engine/src/desktop/web-search/service.ts` | `searchFailureOf`: pre-effect `Search capability changed.` → explicit error; after-request → `uncertain` (not repeated); real provider errors stay redacted **Search provider failed.** |
| `apps/engine/src/desktop/web-search/service.test.ts` | Unrun: pre-flight / in-flight / withhold body / idempotent replay / new tool-call+generation / provider errors unchanged |
| `apps/ui/lib/desktop/server/auxiliary/backends.ts` | Search pre-flight revision mismatch throws `Search capability changed.` before fetch; post-fetch assertCurrent mismatch throws after-request variant |
| `apps/ui/lib/desktop/server/auxiliary/backends.test.ts` | Unrun: pre-flight mismatch never calls fetcher |

**Preserved:** outcome store begin/complete identity+fingerprint; immutable old-run selection; accepted response withholding; new tool-call/new revision separately admissible; public-fetch URL pin / private DNS rejection unchanged; no keys read; no provider/fixtures executed this checkpoint; no global registry edits.

## Classification

```ts
// pre-effect (no provider request): { status:"error", message:"Search capability changed." }
// after provider request may have started: { status:"uncertain", message:"Search capability changed during the request. The search was not repeated." }
// transport/auth provider failure: { status:"error", message:"Search provider failed." } (redacted)
// fingerprint includes adapterGeneration ⇒ new key/revision is a new fingerprint; old uncertain/error receipt never retries with the new key
```

## Root / dependent labels

- Outcome store + `/api/desktop/internal/web-search` already mounted (`auxiliary/search.ts`). No new routes/migrations/contracts barrels.
- Not edited: contracts `desktop-web-search.ts`, global tool registry, public-fetch module.

## Unrun regressions (not executed)

pre-flight revision change; in-flight rotation → uncertain + no same-fingerprint retry; body withheld on post-response generation mismatch; idempotent replay of retained capability-changed; new toolCallId + new generation admitted; Stop/deadline cancelled unchanged; workspace/grant isolation via existing authority; provider 4xx/5xx still **Search provider failed.** redacted.

## Execution NOT run

No vitest/typecheck/lint/build/install/fixtures/provider/network/Keychain/live data/UI/Docker/listeners/restart/push/PR.

## Remaining gates

C–I / root central conversation+notifications / RD41 root snapshot-board-panels / copy-grants remain pending. Do **not** mark whole RD40 accepted.

## Proposed PR text

**Title:** `fix(desktop): classify search capability revision vs provider failure`

**Body:** Map pre-flight search key/revision changes to Search capability changed. Persist uncertain when the provider request may have started. Never retry the same fingerprint with a new key. Keep provider-error redaction and response withholding.

## Status

SOURCE-REPAIRED · ROOT-UNVERIFIED · tests not run · no push/PR · checklist not mutated · RD40 not accepted
