# Round 31 — coworker calls, delegation, app skills and browser parity

Original source pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.
The assignment base contains the accepted browser integration. Round 30 templates,
setup, suggested apps and image formats are under root review in parallel; their
source handoffs are not accepted yet. Do not modify or depend on their worktrees.

Root owns integration, every repair, all execution checks, dependencies, builds,
signing, the installed app, providers, Docker, credentials and native/restart QA.
Lanes write code and focused regression sources only. No tests, typecheck, lint,
build, install, servers, live APIs, UI actions, Docker, Keychain, push or merge.
Do not modify another lane's source or replace original shared components.

## Ownership

| Lane | Task | Owned paths |
| --- | --- | --- |
| A | E10 persistent coworker calls | `packages/contracts/src/desktop-coworker-calls.ts`, `apps/engine/src/desktop/coworker-calls/**`, `apps/ui/lib/desktop/server/coworker-calls/**`, `apps/ui/app/api/desktop/sessions/[sessionId]/coworker-calls/**` |
| B | C8 original persistent-call progress and exact-chat navigation | `apps/ui/components/desktop/coworker-calls/**`, `apps/ui/lib/desktop/coworker-calls-client.ts` |
| C | C4 original @coworker composer suggestions | `apps/ui/components/desktop/mentions/**`, `apps/ui/lib/desktop/coworker-mentions.ts`, `apps/ui/lib/desktop/server/coworker-mentions.ts`, `apps/ui/app/api/desktop/coworkers/[agentId]/mentions/**` |
| D | E10 ephemeral delegation | `packages/contracts/src/desktop-delegation.ts`, `apps/engine/src/desktop/delegation/**`, `apps/ui/lib/desktop/server/delegation/**`, `apps/ui/app/api/desktop/sessions/[sessionId]/delegation/**` |
| E | C8 original delegated-task progress and Stop | `apps/ui/components/desktop/delegation/**`, `apps/ui/lib/desktop/delegation-client.ts` |
| F | E4 connector-owned usage skills | `apps/ui/lib/desktop/server/services/skill-resources.ts`, `compiler.ts`, `lifecycle.ts`, adjacent service skill modules/cases; new `apps/engine/src/desktop/service-skills/**` if needed |
| G | E3 original browser navigation options and bounded page exports | `apps/engine/src/desktop/isolated-screen/{types,page,service,transport,tools}.ts`, new export helpers/cases in that directory, `apps/engine/desktop-guest/guest.py` and adjacent guest export helpers/cases |
| H | E3 original live browser preview during ordinary runs | `apps/ui/components/desktop/browser-runs/**`, `apps/ui/lib/desktop/browser-run.ts` and adjacent cases |

Root reserves central contract exports, schemas/migrations, tool registry/grants,
provider bridges, run/queue/admission/lifecycle integration, central route mounts,
`DesktopApp`, `DesktopBoard`, `DesktopConversation`, shared renderer, Control
Center, packaging and signing. Return typed integration fragments for these.

## A / B / C: one persistent-call contract

A owns the only `DesktopCoworkerCallSnapshot` and `DesktopCoworkerCallTarget`
definitions. B/C import them directly from the source contract until root exports
them; never duplicate or invent a parallel response schema. A must retain this
minimum shape (additional safe fields are allowed):

```ts
type DesktopCoworkerCallTarget = {
  agentId: string; name: string; handle: string | null;
  boxName: string | null; enabled: boolean; callable: boolean;
}
type DesktopCoworkerCallSnapshot = {
  callId: string; revision: string; parentAgentId: string;
  parentSessionId: string; parentRunId: string; toolCallId: string;
  targetAgentId: string; targetSessionId: string | null;
  targetName: string; wait: boolean;
  status: 'queued' | 'running' | 'dispatched' | 'waiting-human' |
    'completed' | 'error' | 'cancelled' | 'interrupted';
  createdAt: string; updatedAt: string;
  progress: { steps: number; toolCalls: number; failures: number;
    preview: string; calls: Array<{tool: string; status: string}> };
}
```

All IDs exposed to UI are local public identities. Engine IDs, credentials and
private contexts stay server-side. Calls are created only by a trusted current
tool invocation. The source identity includes exact caller/run/tool-call IDs;
persist a reservation before creating a child session or executing work. Replay
of that identity reconciles the same child and never dispatches twice. A stale
run, deleted/disabled owner, revoked grant or changed target refuses. No automatic
restart of a possibly executed run after process death; retain an honest status.

Use an injected authority/factory, not a new global singleton. Reuse original
`call_agent` name, wait/default dispatch semantics, target-name disambiguation,
progress and parent/child provenance. A current per-coworker default-off call grant
plus explicit allowed target IDs governs execution; injected authority validates
both local identities and current target enabled state. An @mention never grants
access. Resolve names deterministically and reject duplicates rather than guessing.
Never copy private memories/files/chats, secret strings or browser profiles into
the caller. The target uses its own existing model and grants. Prevent loops and
bounded-depth fanout. Limits must be named and explicit, not silently truncated.

GET `/api/desktop/sessions/[sessionId]/coworker-calls` returns `{calls: Snapshot[]}`.
POST accepts only `{operation:'stop', requestId, callId, expectedRevision}` and
returns `{call: Snapshot}`. It stops only the named child owned by that parent;
repeated/late Stop cannot affect another run. Dispatched children retain original
independent lifecycle; document parent cancellation semantics separately for wait.
Pending human requests must reach their actual target chat and attention flow.

B adapts original `CallAgentBlock`, `SubRunBlock`, progress helpers and associated
layout. If the original export/name differs, cite the exact equivalent. Read-only
polling stops on unmount/owner change. An injected
`onOpenTarget({agentId,sessionId}):Promise<void>` opens only a server-returned target
after a fresh ownership check. Never infer completion from a closed stream.

C ports original `MentionAutocomplete` agent suggestions, Box hint, preferred
ordering, keyboard selection and composer token semantics without breaking /skills.
GET `/api/desktop/coworkers/[agentId]/mentions` returns `{targets: Target[]}` through
root-injected current local roster authority; never return engine IDs. A supplied
draft mention stores the selected immutable local ID plus its visible token and
text range. Revalidate that range and current target at send; rename/delete/duplicate
names cannot redirect an old selection. Typed plain names remain plain text until
unambiguously resolved by the tool. Return integration helpers for durable drafts,
queued sends and regenerated history; do not edit those central routes. Token
selection itself neither sends a message nor changes grants.

## D / E: ephemeral delegated tasks

D owns `DesktopDelegationSnapshot` and child task contracts; E imports them without
duplicates. Minimum snapshot: `{delegationId, revision, parentAgentId,
parentSessionId, parentRunId, toolCallId, tasks}`. Each task has `{taskId, title,
status, startedAt, finishedAt, steps, toolCalls, failures, preview, calls}` using
original SubRunTask-compatible status/progress types. Keep public IDs only.

Preserve `delegate_tasks`, ordered results and original four-worker ceiling.
Child authority is a strict subset of the parent turn's current grants/model;
no copied secrets, native credentials or private histories. Do not copy upstream
implicit widening of shared-write permission. No recursive delegation, persistent
coworker calls, user requests, setup completion, routine/trigger/install/publish
tools or automatic broad permissions in a child. If a permission cannot be safely
inherited with current Mac isolation, refuse that tool explicitly. Parent or
per-task Stop drains and stops the owned run before removing only its exact
ephemeral resources. Persist reservations, outcomes and cleanup ownership first;
restart never re-executes uncertain tasks or removes a replacement directory.

GET `/api/desktop/sessions/[sessionId]/delegation` returns `{delegations: Snapshot[]}`.
POST accepts `{operation:'stop-task',requestId,delegationId,taskId,expectedRevision}`
and returns `{delegation: Snapshot}`. Default-off delegation grant and trusted
current tool invocation are required. Root injects existing runtime/provider,
store, shared-output authority and admission; no independent engine instance.

E reuses original `SubRunTree`/`SubRunBlock`/StepRow display, ordered live branches,
settled result and per-task Stop. Use typed callbacks and the exact contract. A
failed Stop remains retryable and cannot leave a permanently disabled button.
Render durable outcomes after restart; do not fabricate lost live timing/events.

## F: bundled app usage skills

Complete the existing catalog's blocked usage-skill slice for the already-supported
anonymous/Bearer HTTPS methods only. Follow original service compiler, registry
footprints and connectorSkillOwners. Use bundled, validated manifest skill content;
no arbitrary remote downloads or new authentication methods. Preserve secret
substitution exclusions. Use one canonical install receipt and exact resource
identities/hashes for recovery and removal. Never overwrite user skills or delete
an edited/replaced directory; repeated connect/disconnect/remove remains safe.
Reconcile partially-created skill resources before allowing tool use. Connector
skills appear read-only to the coworker and local editor, and are excluded from
ordinary template capture/export. Disconnect must not secretly revoke a provider
credential. Do not widen service or skill grants. Reuse the existing lifecycle,
not a parallel connector system. Root handles registry exposure and central UI.

## G: original browser page options

Port `links`, bounded `timeoutMs`, optional `screenshotPath`, and saved rendered
HTML from original browser.ts/page-file.ts through the installed isolated runtime.
Keep existing navigation, consent/bot-wall behavior, cancellation acknowledgments,
generation checks and exclusive control. No host mounts, host browser/CDP access,
ports or filesystem RPC. Host receives bounded validated data only. Timeout is
positive and at most original 120000ms. Full-page captures have explicit dimension,
pixel, byte and elapsed limits; reject oversized output rather than silently
claiming a full screenshot. Saved HTML is an inert file; never render it as trusted
app markup. File destinations are confined to this coworker's private workspace,
no links/hardlink aliasing/traversal or overwriting changed files. Validate current
write permission when publishing exports; navigation without export still works
under the browser/computer grants. Root supplies final grant/bridge wiring.

## H: ordinary-run live screen

Reuse original `ChatScreen`, ScreenCard and existing DesktopViewer presentation.
Provide an adapter receiving exact `{agentId,sessionId,runId,liveScreen}` from
root's trusted current-run projection. A card appears only for the active run's
real browser/computer work, never historic text/tool-name guesses. Passive viewing
must not start a stopped runtime or acquire control. Unmount/stop/tab/coworker
switch closes only that viewer subscription and never another human's control.
Use current existing session transport; do not create another lease manager or
persist viewer tickets. Explicit Open uses an injected callback for the original
dialog; it does not answer a pending takeover. Root owns live event emission,
current-state server checks and DesktopConversation mounting. Preserve the board
and chat scroll/draft when opening/closing. Include unavailable/retry states.

## Handoff

Read applicable AGENTS.md/CLAUDE.md and installed Next.js guides. Read the actual
original source before porting, and cite file names in the handoff. Preserve
responsive layout and original interactions. Stay in your assigned worktree.
Author useful regression cases but execute none. Commit only your owned source
and a new round31 lane handoff document. Return full SHA, clean status, changed
files, exact root wiring and honest unverified limits. Root fixes every defect
and runs all checks; a source handoff is not product acceptance.
