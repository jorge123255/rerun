# Desktop Find chat

Base: `cc3c9362c721c6c4378791d18a582891fa56e4d2`.

The Team board's Find chat dialog searches saved local titles across the workspace.
Each result includes the coworker's name and carries both local coworker and session
IDs. Opening a result selects that exact session, including older sessions. If it
has disappeared, the UI reports that instead of opening the newest conversation.
The existing per-coworker Chats menu still selects sessions normally.

The authenticated, read-only `/api/desktop/conversations/search` endpoint queries
the local app database, joins workspace-owned coworkers, and returns at most 50
matches with a refinement hint when more exist. Queries are bound SQL parameters;
wildcard characters are literal. Search starts at two characters, is limited to
200 characters, and uses SQLite's `lower` case folding. It does not depend on an
available engine. The dialog debounces requests, aborts stale reads, supports
keyboard selection, and distinguishes no matches from a failed read.

Upstream reviewed at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/control-center/useConversationSearch.ts`
- `apps/ui/components/control-center/ControlCenter.tsx`
- `apps/ui/components/control-center/ControlCenterView.tsx`
- `apps/ui/app/api/_services/conversation.service.ts`

The port follows its title/coworker result labels, debouncing and exact-session
selection, using shared Command/Dialog components and the local authenticated
store rather than cloud workspace services.

## Validation

From `apps/ui`, use Node 22 and run:

```sh
RERUN_FIND_CHAT_ACCEPTANCE=1 node node_modules/vitest/vitest.mjs run \
  app/api/desktop/conversations/search/route.test.ts \
  app/api/desktop/conversations/search/real-engine.test.ts \
  components/desktop/DesktopFindChat.test.tsx \
  components/desktop/DesktopChatHistory.test.tsx \
  components/desktop/DesktopApp.interaction.test.tsx \
  components/desktop/DesktopApp.test.tsx \
  components/desktop/DesktopBoard.test.tsx \
  components/desktop/DesktopConversation.test.tsx \
  components/desktop/DesktopConversation.switch.test.tsx \
  components/desktop/DesktopConversation.stop.test.tsx \
  app/api/desktop/routes.test.ts lib/desktop/server/store.test.ts
```

The first group of ten test files passed 41 tests; the two existing conversation
switch/stop files passed another seven. Contracts and engine builds, UI typecheck,
focused ESLint and `git diff --check` passed.

The opt-in test starts the actual desktop engine with disposable storage and a
deterministic loopback provider. Alice and Bob each save a conversation called
Shared plan with distinct replies; an additional conversation makes Alice's
target older than the latest. It verifies exact transcripts, no matches, and
database plus engine restart persistence. Automatic memory curation is disabled
only in these test coworkers so it cannot consume numbered fixture replies.

On this Mac, browser acceptance used the desktop UI, an actual desktop engine,
and a disposable workspace with a loopback provider. Alice and Bob each had
Shared plan plus a newer chat. Find chat opened each correct older transcript;
mouse and keyboard selection worked. Bob's existing Chats menu switched between
the newer chat and Shared plan. No-match text was verified. After stopping and
restarting both UI and engine processes, opening the workspace and repeating both
search selections and no matches gave the same results. Layouts at 375x700,
768x700 and 1200x700 kept the dialog in the viewport without horizontal overflow.

Packaged Electron launch/restart and installation were not tested. No installed
app, live workspace, user account or model setting was changed. Integration,
packaging, pushing and installation remain with the coordinator.

## G2 integration with attachments

Merged audited desktop revision `e6a8eb1fd0f13d774c9a1a2595307c2879f60bdf`
into `desktop/find-chat` from reviewed Find chat `62638d0a79813a95e51dd10abdf692cf701b8a7f`.
The shared disposable provider now captures each request's actual `messages`
and uses that captured request's position for its optional numbered reply.
Its default reply and attachment snapshot assertions are unchanged. The Find
chat acceptance test now creates newer chats for both coworkers and verifies
that reply text is not searchable as a title.

The following combined run passed 36 tests in eight files with both acceptance
flags enabled (including both real-engine tests, neither skipped):

```sh
RERUN_FIND_CHAT_ACCEPTANCE=1 RERUN_ATTACHMENT_ACCEPTANCE=1 \
  node node_modules/vitest/vitest.mjs run \
  app/api/desktop/conversations/search/real-engine.test.ts \
  app/api/desktop/chat/attachment.real-engine.test.ts \
  app/api/desktop/conversations/search/route.test.ts \
  components/desktop/DesktopFindChat.test.tsx \
  components/desktop/DesktopConversation.attachment.test.tsx \
  components/desktop/DesktopChatHistory.test.tsx \
  components/desktop/DesktopApp.interaction.test.tsx \
  app/api/desktop/routes.test.ts
```

Contracts and engine rebuilds, UI typecheck, focused lint and diff checks passed.
In browser QA on this Mac, a fresh disposable workspace used the actual merged
engine and the deterministic loopback provider. From the Team board, Alice's
and Bob's identical Shared plan titles opened their distinct older replies,
not their newer chats. Their coworker names appeared in search results. The
existing Chats menu switched Bob between Newer note and Shared plan. Searching
for Alice's reply text showed no matching chats. These checks passed again
after restarting both UI and engine processes and reopening the workspace.

No checks in this G2 pass ran in a packaged Mac app. Browser checks and the
real-engine fixture checks above are separate from packaged acceptance; G3
integration/installation remains with the coordinator. No live workspace or
installed app was changed.
