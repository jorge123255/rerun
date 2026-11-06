# RD40 D3 Claude credential generation truthfulness handoff

**Kind:** narrow source repair — **not** RD40 complete, **not** accepted, **not** tested.  
**Branch:** `desktop/round38-master-completion`  
**Frozen base:** `6f6ad959a09abaf1947950b6f82413c94407e22a`  
**Original pin:** `2a57fa6dd53311f763bfc9abde85997b7f7e5309` (hosted Claude plan steps / token helper; Mac isolation stays)  
**Parent tip before this commit:** `c183cd50993cfeab142278f6389899ceb477f576`  
**Impl SHA:** `4415d3193bc467d0f25cbd9fdfdb3d76bf5c65f8`

## Defect (verified)

With an encrypted `CLAUDE_CODE_OAUTH_TOKEN` present, `start` / `cancel` / failed `complete` wrote AUTH phases `waiting` / `cancelled` / `error`. `publicState` published those phases while the runner still injected the token. UI `linked = phase === 'connected'` treated the account as signed out. Disconnect remained the only path that deleted the token.

## Change

| Path | Role |
|---|---|
| `packages/contracts/src/desktop-claude-plan.ts` | Optional `pendingAttempt` (+ type); no barrel/index edit |
| `apps/engine/src/desktop/claude-plan/auth.ts` | `projectDesktopClaudePlanSnapshot`: token ⇒ `phase: 'connected'` + `credentialRevision`; in-flight replace ⇒ `pendingAttempt`; cancel with token restores AUTH `connected`; fail keeps AUTH `error` but projects connected + `error` |
| `apps/engine/src/desktop/claude-plan/auth.test.ts` | Unrun generation / cancel / fail / drain-order / disconnect / redaction cases |
| `apps/ui/lib/desktop/claude-plan-client/use-desktop-claude-plan.ts` | `linked`, `attemptPhase`, pending-aware submit/cancel/unmount |
| `apps/ui/lib/desktop/claude-plan-client/runtime.ts` | Cancel matches `pendingAttempt.phase` |
| `apps/ui/components/desktop/claude-plan/DesktopClaudePlanSteps.tsx` | `linked` / busy from hook |
| `apps/ui/components/desktop/claude-plan/DesktopClaudeLogin.tsx` | Disconnect refuses pending waiting/checking via pendingAttempt |

**Preserved:** Seatbelt/profile/encrypted env/PKCE/API-key paste refusal; `beforeCredentialChange` (= `stopDesktopClaudeWorkers`) before credential write; disconnect deletes token + bumps generation; no raw secrets in snapshots.

## Contracts

```ts
pendingAttempt?: { attemptId, phase: 'waiting' | 'checking', authorizeUrl?, error? }
credentialRevision?: string  // present iff durable TOKEN exists
// When TOKEN exists: phase is always 'connected' at projection time.
```

## Root activation

None for engine bind. Settings consumers already use PlanSteps/Login updated here. If another panel hard-codes `phase === 'connected'` without `credentialRevision` / `linked`, point it at `credentialRevision` or hook `linked`.

## Unrun regressions (not executed)

Replacement start/cancel keeps token + connected; failed exchange connected+error; drain-before-write order; disconnect after cancel; no-token waiting unchanged; snapshot redaction; existing suite expectations updated for projected connected.

## D4 note

Prior clear wipe (`d0b2a798…`) unchanged this checkpoint. Root should still concurrency-test clear vs semantic wipe under load; no new-note behavior altered here.

## Remaining RD40

Native nontext receipts; search rotated-key classification — next checkpoint. C–I untouched.

## Proposed PR text

`fix(desktop): keep Claude generation linked during replacement attempts`

Publish durable Claude OAuth credentials as connected with credentialRevision while pendingAttempt tracks replacement. Cancel and failed exchange no longer hide or delete an executable token.

## Status

SOURCE-REPAIRED · ROOT-UNVERIFIED (no live Claude account) · tests not run · no push/PR · checklist not mutated
