# calledBy trace

Base: `abf3c3033e163a73ad06818b91ee5978218d3ffb`, tree `284cff5800a1b0bfef33dcdfb81c6b881eac60b6`.

Upstream: `71a2952cc8f3d91d2f40c3e6d27b82e07bbd7f97` (`fix(harness): keep coworkers delivering instead of looping or waiting`, rerun-build/rerun #77). Fetched read-only. Only the called-coworker brain text is in scope. Create/rename wording, onboarding, and published-access copy stay unported.

`calledBy` means this run was started because another coworker sent it a message through `call_agent`. The called coworker answers from its own brain and must not be told to pass an empty-brain question on to yet another coworker.

## Coworker-to-coworker starts (set `calledBy`)

Both paths open a fresh session on the target coworker and launch it with `startHeadlessRun(..., { source: 'chat' })`. The caller id is already known there. Neither path is a user chat, a schedule, or a webhook.

1. Hosted `call_agent` — `apps/engine/src/tools/builtin/call-agent.ts` (`callAgentTools`). Used when `desktopApp()` is false (`apps/engine/src/tools/registry.ts`, `cfg.callAgent && ctx.callTargets?.length`). The caller is `ctx.agent.id`. The session origin is already `originAgentId: ctx.agent.id`. Upstream passes `calledBy: ctx.agent.id` here. This fork does not pass `callableAgentIds`; that stays unchanged.

2. Desktop `call_agent` — `apps/engine/src/desktop/coworker-calls/tool.ts` (`desktopCallAgentTools`) sends `engineAgentId: ctx.agent.id`. `apps/engine/src/desktop/coworker-calls/runtime.ts` (`startChildRun`) forwards that as `originAgentId`. `apps/engine/src/desktop/coworker-calls/bind.ts` (`startChildRun`) is the only desktop `startHeadlessRun` for that tool. Wired when the desktop grant is on (`registry.ts` and `apps/engine/src/desktop/foreman/binding.ts`). The caller id to store is `input.originAgentId` (the calling coworker's engine id, including a Foreman that used this same tool). `desktopCoworkerCallee` only turns self-improvement off and, for a Foreman caller, turns the target's further `callAgent` / `delegate` grants off. It does not choose the brain text.

## Not coworker-to-coworker (do not set `calledBy`)

- Desktop delegation — `apps/engine/src/desktop/delegation/host.ts` `startHeadlessRun` with `{ source: 'chat' }`. The child is an ephemeral agent (`name: 'Delegated task'`, `ephemeral: true`, session source `delegate`) doing one task for the parent. It is not another persistent coworker. `desktopDelegationChildTools` replaces the tool set, and `delegation/runtime.ts` blocks `call_agent`. A parent handing off a subtask is not "called by a coworker".

- Hosted `delegate_tasks` — `apps/engine/src/tools/builtin/delegate.ts` calls `runAgent(child, session.id, prompt)` with no trigger. `runAgent` defaults that to `{ source: 'chat' }`. The child is ephemeral, `callAgent` is forced off, and the session source is `delegate`. Same reason: not a persistent coworker call.

- Desktop triggers — `apps/engine/src/desktop/triggers/runtime.ts` `startTriggerRun` uses `{ source: 'trigger', slug, name }` for the owner coworker. The session source is `trigger`. A webhook is not another coworker.

- Hosted triggers — `apps/engine/src/runtime/trigger-runner.ts` `fireTrigger` uses the same `{ source: 'trigger', slug, name }` shape.

- Schedules — `apps/engine/src/runtime/scheduler.ts` uses `{ source: 'schedule', slug, name, requireExactModel? }` for the owner coworker. Session source is `schedule`.

- User and Foreman chats — `apps/engine/src/http/routes/chat.ts` and `apps/engine/src/desktop/foreman/routes.ts` call `runAgent` with `{ source: 'chat', ... }` and no caller coworker. Those runs are the person talking, not a coworker call.

`RunTrigger` in `apps/engine/src/runtime/context.ts` has no `calledBy` yet. `startHeadlessRun` forwards the trigger object into `runAgent`, and `runAgent` passes it to `buildSystemPrompt`. The hosted brain section is `buildBrainSection()` with no argument (`apps/engine/src/agents/systemPrompt.ts`), which always appends `EMPTY_FOR_AGENTS` when the index is empty (`apps/engine/src/brain/prompt.ts`). That sentence tells the coworker to `call_agent` other coworkers. On the desktop app, `buildSystemPrompt` does not call `buildBrainSection`; it uses `DESKTOP_BRAIN_INSTRUCTION`, which does not contain that sentence and does not inject company pages. The Foreman section is `buildForemanBrainSection()` and stays on the plain empty line.

## Mac review

The desktop caller context now selects an operating note for the called coworker. It replaces the generic instruction to call another coworker for this turn. The note directs the recipient to answer from its own context and permitted sources, explain gaps, and return the result to the caller. It does not inject the caller id or read company data. The Mac brain tool instruction still requires the existing grant. The authorization, target allowlist, call depth and loop checks are unchanged.
