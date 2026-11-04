# Control Center coworker panel shortcuts

Implementation source: `4032e9fcdfa6de9f593824432e4dabda8de8d763`.
Original Rerun reference: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

The coworker drill now reuses the original **Open** section from
`components/control-center/ControlCenter.tsx` and the supported entries from
`components/agent/agent-tabs.ts`. Labels, descriptions, icons and order are shared:
**Chat**, **Knowledge**, **Files**, **Capabilities**, **Monitoring**, **Settings**.
Knowledge opens the installed Memories dialog; Capabilities opens Tools; Settings opens
Edit coworker. Unsupported hosted surfaces are not offered.

The shared `ControlCenterView` keeps its keyboard drill, breadcrumbs and search. Open rows
appear before the existing Open chats / Recent conversations lists. A search inside a coworker
stays scoped there, including `/` or `@` prefixes. Rows verify current owner, callback, open
cycle, disabled state and Quit state before acting.

Navigation is transient and bound to the selected coworker and active chat tab. Opening a
dialog does not recreate the conversation or replace its persisted tab/draft identity. The
existing wrappers accept optional controlled dialog state; their Files dirty-close guard,
save-in-progress guards and data reads remain in place. Closing returns to the coworker card;
Chat/Back focuses the composer, and Escape from the card retains its original focus behavior.

Settings waits until a restored chat's run-status read belongs to that session. A running
reply shows a wait notice and consumes the request. Back/Close or an explicit other-panel
selection cancels a pending request, so a late status cannot replace an open file editor.
The manual Edit action is also unavailable while run status is unknown. Opening a covered
panel does not mark the hidden reply as read.

## Root verification

Only root executes checks, builds and app QA. Internal helpers authored source/regressions
and performed source reviews without running checks or touching the real app.

Actual-App regressions retain real board/chat/dialog components and cover all six shortcuts,
repeated opening, same-name files belonging to different coworkers, two visited chat tabs,
independent drafts after remount, restored live-status gating, cancellation before status
arrives, and explicit Files selection superseding a pending Settings request. The existing
command tests also cover removed callbacks/owners, scoped prefixes, stale rows and quitting.

Root verification on the implementation source: **3,642 UI tests passed, 20 existing skips**
(413 passed files, 13 skipped). UI typecheck, production packaging, bundled-runtime verification
and the single-preview installation passed. Engine source is unchanged; no new engine-suite
run is claimed. The final full suite includes the native rename helper cases. An earlier run
without that helper skipped 19 additional cases; that run is not the release result.

Native acceptance passed in the installed Mac app. Root opened a disposable coworker from
the board and sent “What is 17 plus 56? Reply with just the number.” Signed-in Codex replied
**73**. Root entered an unsent draft, then used the original Control Center drill to open
Knowledge, Files, Capabilities, Monitoring and Settings. The panels showed the correct note,
text file, tool controls and recorded one-run activity. Scoped `/Files` and `/Settings` stayed
with the selected coworker. Root saved **Concise**.

Computer Use then repeatedly timed out while the user confirmed Rerun remained responsive.
The user fully quit and reopened the app to restore native control. After that restart, root
visibly reopened Chat, Settings, Files and Knowledge: reply **73**, the unsent draft, **Concise**,
the primary file and primary note all remained. A read-only before/after comparison also
matched exact files, memory identities/content, settings, chats, messages, tabs and drafts.
Only computed, time-decaying memory strength was excluded from equality; saved note data
was compared unchanged.

Root then opened a second coworker's same-named file and its Knowledge and Settings panels.
They showed the separate **19** file/note markers and **Normal** reply length. Returning to the
primary through Chat retained **73** and the original unsent draft and focused its composer.
Two-tab/two-draft remount coverage is automated; this native slice checked one saved draft.

With the app fully closed, root made a byte-verified recovery copy of the completed QA
workspace and checked database integrity. Root removed only the two recorded temporary
fixtures through the authenticated local deletion API, then quit and reopened the app.
Final read-only checks confirmed their folders/rows were gone, database foreign keys were
clean, and all original **23 chats / 88 messages** retained their exact identities and contents.
Workspace name/icon, appearance and Codex provider/model/reasoning defaults were unchanged.
The clean build worktree and installed runtime manifest both identify the source above.
