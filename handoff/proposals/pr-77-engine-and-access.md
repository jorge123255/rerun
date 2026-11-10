# Proposal: remaining #77 wording outside the Mac setup builder

Do not apply this on the desktop setup branch. The files below already diverge from upstream (desktop grant gates, `desktopApp()` branches) or belong to another lane. #77 is `71a2952cc8f3d91d2f40c3e6d27b82e07bbd7f97`, parent `3d23e811290401a8d992f051d0b8549d5a92be0c`.

The Mac install text is ported in `apps/ui/lib/desktop/server/foreman/seal.ts` (`firstInstall`). These leftovers are not required for that path.

## `apps/engine/src/agents/systemPrompt.ts`

Upstream changed four prompt blocks. The desktop file already has its own branches, so a wholesale replace would drop grant and desktop-tool wording.

- Vocabulary note: tell the user how to add or rename a coworker from the board, and do not claim the coworker can create one.
- Computer note: when posting or applying is the job, the site sign-in is the next step, not an optional paste-it-yourself alternative.
- Quick replies: a click only sends text, so a reply must not claim the user approved, clicked a button, or signed in outside the chat.
- `ask_user`: a question the user skipped is answered. Continue with an explicit assumption, deliver, and do not ask it again unless they bring it up.
- `setupNote`: "ask with ask_user for what you need" instead of "ask for anything you need with ask_user rather than guessing". The desktop setup note is already result-first (`setupNote` in this file). It still uses the older ask sentence.

## `apps/engine/src/brain/prompt.ts`, `apps/engine/src/runtime/context.ts`, `apps/engine/src/tools/builtin/call-agent.ts`

Upstream stops a coworker that was called by another coworker from passing the question on:

- `RunTrigger` for `source: 'chat'` gains `calledBy?: string`.
- `call_agent` passes `calledBy: ctx.agent.id` into `startHeadlessRun`.
- `buildBrainSection(calledByCoworker)` uses `EMPTY_WHEN_CALLED` ("answer it from what you already hold... and never pass its question on") instead of `EMPTY_FOR_AGENTS`.

This is reply/run ownership, not the Foreman install builder. Leave it for that lane. Tests that would move with it: `apps/engine/src/tools/builtin/brain.test.ts` and `call-agent.test.ts`.

## `apps/ui/lib/published/access.ts`

When a public link is refused by policy, upstream tells the coworker to point at the button on the link card ("any member can click", "no admin needed", "offer no quick reply"). The desktop copy still says a person was asked in the chat. Not part of coworker setup. Test: `apps/ui/lib/published/access.test.ts`.
