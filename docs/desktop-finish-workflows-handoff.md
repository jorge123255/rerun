# Desktop workflow restoration — source handoff

Source implementation only. No checks were executed. No installed acceptance. No merge, deploy, or release.

## Base and tip

| | |
|---|---|
| Published base | `desktop/finish-cloud-base-20261106-8297fe64` → `8297fe6404caa114dcb0c2cd6006291a8abb2038` |
| Implementation branch | `cursor/desktop-c8-c9-b5-workflows-dbba` |
| Tip | recorded in the commit that adds this file |
| Official reference | `ab3def9bfcf545cc9548f99c63c2b011ca094023` |
| Earlier pin | `2a57fa6dd53311f763bfc9abde85997b7f7e5309` |
| RD37 H notice | not on this base. This change does not reimplement `DesktopProviderErrorNotice`. It adds the resume stream H does not provide. The stop status field is named `failedRunError`, which H’s unmerged controller reads. The value is the newest run’s error only, matching official `lastRunError`, not an older error behind a later run. |

## What landed

1. **C8 live resume and failed-run replay.** `GET /api/desktop/sessions/:sessionId/resume?runId=` reattaches with `reconnectRun` only when that run is the current running run of the session’s coworker in this workspace database. A finished, foreign, or unbuffered run returns HTTP 204 with `x-rerun-resume: unavailable`. The route never calls the chat POST. History and the stop status expose the newest run’s error text. The transcript banner hides that text when the latest assistant message is already that exact string. A dropped stream uses the existing `useRunReconnect` hook against this resume URL. Reopen of a still-running reply calls `resumeStream` once. Run-list failure is `runsUnavailable` and does not pretend the reply finished or start another turn.

2. **C9 long draft.** The desktop composer mounts the existing `MarkdownEditorDialog` when `isLongMessage` is true (more than 300 characters or at least 3 lines). Cancel and a blocked send write the text back through the current draft updater, so attachments, mentions, and the saved draft stay. The dialog is not a second draft store.

3. **B5 find.** The second modifier-F closes Control Center and dispatches `rerun-desktop-conversation-find`. The open conversation shows a find field that calls `desktop:find-in-page`. The shell searches only `event.sender` via `findInPage` / `stopFindInPage`. The renderer cannot pass a URL, path, or command. If the bridge is missing, the field says find is unavailable and does not invent matches.

## Changed paths

- `apps/ui/lib/desktop/chat-resume.ts`
- `apps/ui/lib/desktop/chat-resume.test.ts`
- `apps/ui/lib/desktop/server/chat-resume.ts`
- `apps/ui/lib/desktop/server/stop-turn.ts`
- `apps/ui/app/api/desktop/sessions/[sessionId]/messages/route.ts`
- `apps/ui/app/api/desktop/sessions/[sessionId]/resume/route.ts`
- `apps/ui/app/api/desktop/sessions/[sessionId]/resume/route.test.ts`
- `apps/ui/app/api/desktop/sessions/[sessionId]/stop/route.test.ts`
- `apps/ui/components/desktop/DesktopConversation.tsx`
- `apps/ui/components/desktop/DesktopConversationFind.tsx`
- `apps/ui/lib/desktop/control-center.ts`
- `apps/ui/lib/desktop/find-in-page.ts`
- `apps/desktop/src/main/find-in-page.mjs`
- `apps/desktop/src/main/index.mjs`
- `apps/desktop/src/main/preload.cjs`
- `apps/desktop/test/find-in-page.test.mjs`
- `docs/desktop-finish-workflows-handoff.md`

## Central mounts

- `DesktopConversation` owns resume, the failure banner, the long-message dialog, and the find field. `DesktopApp` was not rewritten.
- `useDesktopControlCenterKeys` dispatches the find event when the center is already open. The first modifier-F still opens the center.
- `index.mjs` registers only `desktop:find-in-page`, behind the existing `trusted` sender check.

## Security bounds

- Resume resolves the desktop session in the active workspace database, then requires `run.agentId` and `run.sessionId` to match that coworker’s engine ids. The requested id must be the current running run.
- Resume does not set `x-session-id`. The composer fetch wrapper does not treat a resume response as a new send, so drafts are not cleared and `onChatSession` is not called.
- Find input is `action` plus a query of at most 200 characters with no NUL. Stop and an empty query only call `stopFindInPage('clearSelection')`.
- No new host command, entitlement, listener, or update feed.

## Root integration fragments

None required for these three paths. They are mounted in the files above.

When RD37 H is integrated later, keep its `DesktopProviderErrorNotice` as the classified-error UI. Point its retry and continue actions at the existing send and regenerate paths. Do not add a second resume client. Read `failedRunError` from the stop status this branch already returns. Do not treat HTTP 204 `x-rerun-resume: unavailable` as a successful stream.

## Authored regressions, not run

- `apps/ui/lib/desktop/chat-resume.test.ts` — newest failure, live run wins over an older failure, transcript does not double the same text, foreign and finished ids are not resumable.
- `apps/ui/app/api/desktop/sessions/[sessionId]/resume/route.test.ts` — live stream does not POST `/chat`; finished and other-session ids are unavailable; history returns the newest error.
- `apps/desktop/test/find-in-page.test.mjs` — command parser rejects exec, overlong queries, and non-objects.
- `apps/ui/app/api/desktop/sessions/[sessionId]/stop/route.test.ts` — expectations include `failedRunError: null` for the existing held-turn cases.

## Checks not run

No test, typecheck, lint, build, install, fixture, formatter, UI, browser, native, Docker, database, Keychain, provider, account, listener, or restart was executed for this handoff.
