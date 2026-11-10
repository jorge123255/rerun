# Onboarding result-first trace

Base checkout: `600356a6b903a4e88c3e7641131e455cb9a761b8`, tree `33021f24867bb4ad5b78ce2c25d954cab126ec5e`.

Upstream reference: `71a2952cc8f3d91d2f40c3e6d27b82e07bbd7f97` (`fix(harness): keep coworkers delivering instead of looping or waiting (#77)`), tree `1404bcfe13223c3c943f2f26c106c8ab8a70c7ad`. Parent of that commit: `3d23e811290401a8d992f051d0b8549d5a92be0c`. The #77 diff against `3d23e811` is the behavior being ported. Fetch was read-only (`git fetch --no-tags https://github.com/rerun-build/rerun.git 71a2952cc8f3d91d2f40c3e6d27b82e07bbd7f97`); no remote was added.

## What the Mac does today

A confirmed Foreman plan becomes a coworker in one path:

1. `sealShownPlan` (`apps/ui/lib/desktop/server/foreman/seal.ts:18-29`) seals the card into `DesktopForemanSealedPlan` and a digest. The sealed item has no app list and no connection status. Box and item keys are assigned here.
2. The build runtime (`apps/ui/lib/desktop/server/foreman/runtime.ts:328-333`) creates each agent item with `firstSoul(...)` and `firstInstall(item, asked)`. `asked` is the user's change-request text stored on the build intents.
3. `createCoworker` (`apps/ui/lib/desktop/server/foreman/creation.ts:283-291`) posts those exact bytes to `/desktop/agents/foreman-create`. The engine writes them to `SOUL.md` and `INSTALL.md` (`apps/engine/src/desktop/agent-creation.ts:162-172`) and sets `setup.required: true`, `completedAt: null`, `sessionId: null`, `enabled: false`. No tool grant is accepted on this body (`desktopAgentCreationConfigSchema` has no grants).
4. Explicit Start (`creation.ts:368-398`) enables that one coworker and claims the setup chat. `kickoffSetup` (`apps/ui/lib/desktop/server/setup/service.ts:69-86`) sends `buildInstallMessage(prompt)`, so `INSTALL.md` is the first user message of setup.
5. While setup is pending, the engine system prompt adds `<setup>` from `setupNote` (`apps/engine/src/agents/systemPrompt.ts:177-178`). That note already tells the coworker to show a first result before offering apps, and says that order wins over the order the instructions list.

The connection wait is not a separate Mac wizard. It is step 2 of `firstInstall` (`seal.ts:62`):

> If this job cannot run without one of their apps, ask for every one of them at once, then end your turn and wait until they come back connected. A job that needs no app skips this step.

That sentence is what the setup conversation hears. It fights the setup note and the desktop `suggest_service` description (`apps/engine/src/desktop/service-requests/suggest-service.ts:26`), which already says to continue from the saved setup result when an app was skipped.

App choices already persist on the existing card, not in the sealed plan:

- A new card starts every app at `choice: 'pending'` (`apps/ui/lib/desktop/server/service-requests/service.ts:223`).
- Finish refuses a pending choice (`service.ts:323`, `deriveDesktopServiceSetup` in `packages/contracts/src/desktop-service-requests.ts:226`). Pending is not turned into skip.
- An explicit `choice: 'skip'` becomes outcome `skipped`, unless the saved installation was disconnected (`reset`) or the catalog row is `not-found` (`desktop-service-requests.ts:241-244`).
- `choice: 'use-connection'` becomes `connected` only when that installation is usable now (`desktop-service-requests.ts:235-239`). A missing or unusable installation is rejected, not recorded as connected.
- The follow-up text is `serializeServiceSetupResult` (`packages/contracts/src/chat-hitl.ts:303-311`): `connected`, `skipped`, `reset`, or `not-found`, then "Please continue."
- Those rows live in `desktop_service_suggestion_requests.choices` and `desktop_service_suggestion_receipts.entries`.

`desktop_setup_state.skipped` (`apps/ui/lib/desktop/server/setup/service.ts:40-42`, `schema.ts:20-24`) is a different flag: the user skipped the whole setup panel. It is not a per-app connection status. Setup completion and the Apps / credential grants are also separate. Suggesting an app does not enable Apps (`suggest-service.ts:16-17`). Storing a secret does not grant use of it (`systemPrompt.ts:171`).

Intake (`intake.ts`, `intake-profile.ts`, `intake-history.ts`) only closes discovery and restores company answers. It does not choose apps or connection status. `authority.ts:44-46` states the plan carries no permissions.

## Upstream text being ported

`apps/ui/lib/foreman/build-team.ts` at `71a2952c`, `onboardingInstall` lines 111-120. #77 replaced step 2 and the closing line. Parent `3d23e811` step 2 still said to offer the apps and wait until they come back connected. The new step 2 is:

> If this job cannot run without one of their apps (their mailbox, their CRM, the place their posts go out from), first show what you can already do without it: the job done on what is public (their site or store, its catalogue and pages) or on a sample you label as one. Then offer every one of those apps at once with suggest_service, each tied to what it adds to that result, and end your turn. A skipped app is an answer: keep delivering on what is public and say what the app would add, never that the job is on hold. A job that needs no app skips this step.

The closing line adds: "unless they chose to go on without it."

The desktop builder keeps its own later steps (no `soul_update`, `schedule_create`, `memory_write`, `install_complete`, or `skill_propose` names). Those lines were not part of the #77 hunk. The port changes the wait sentence and the closing line, names the desktop tool that already records the outcome (`suggest_service`), and states that a required permission or credential stays gated.

## Status model this port adds

On top of the existing card outcomes, the setup scope distinguishes:

| Status | Meaning |
| --- | --- |
| `pending` | No explicit choice yet. Not a skip. |
| `failed` | The attempt failed, or the existing outcome was `reset` / `not-found`. Not connected. |
| `connected` | The existing finish outcome was `connected` for a usable installation. |
| `skipped` | The user explicitly chose skip. Not pending, failed, or connected. |

An improving app is offered and does not block the public or labeled-sample result. A required credential or permission stays `pending` or `failed` until `granted`. Skip does not grant it and does not mark it connected. Permissions are copied from the saved or live grant map and are never turned on because an app was offered, skipped, or connected.

Pre-change shapes still load: a sealed plan (`title` / `boxes` / `items`), a setup view (`prompt` / `pending` / whole-setup `skipped`), and a service card (`choices` / `entries`). Whole-setup `skipped` does not become a connection skip. A pending choice stays pending. A saved `false` grant stays false.

## #77 engine hunks not ported here

The desktop copies of these files already diverge (desktop grant gates, `desktopApp()` branches). They are outside the Mac install-instruction builder. Notes for the owners are in `handoff/proposals/pr-77-engine-and-access.md`.

- `apps/engine/src/agents/systemPrompt.ts` — coworker-creation vocabulary, computer sign-in when posting is the job, quick-reply limit, ask_user "a skipped question is answered", and a one-line setup-note rephrase. The desktop setup note is already result-first (`systemPrompt.ts:177-178`).
- `apps/engine/src/brain/prompt.ts` — `EMPTY_WHEN_CALLED` when `calledBy` is set, so a coworker does not pass another coworker's question on.
- `apps/engine/src/runtime/context.ts` and `apps/engine/src/tools/builtin/call-agent.ts` — `RunTrigger.calledBy`.
- `apps/ui/lib/published/access.ts` — public-link copy points at the card button instead of a chat reply.

Lane-owned starter offer, MCP method admission, reply/run ownership, and the Claude runner were not edited.
