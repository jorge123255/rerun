# Desktop Control Center notification commands

Original source/design pin: a6d63a4b542674ddd002e51b39ba0df6e0807bcc.
Source implementation is complete; root automated, installed and native/restart acceptance is pending.

The workspace Settings section now offers Notifications. A coworker's drill also offers the
original Actions → Notifications row, “When this agent reaches you.” Both reuse the original
NotificationsDialog layout and local notification settings; the scoped command pins the exact
coworker using the original CoworkerRules behavior. Opening the row does not create an override
or change the selected coworker, chat, tab or draft. Unsupported account email stays absent.

References: components/control-center/ControlCenter.tsx, lib/control-center/commands.ts,
components/dialogs/NotificationsDialog.tsx, and notifications/settings/CoworkerRules.tsx.
These original sources are unchanged by this port. The Mac adapter uses authenticated local
settings and roster reads, existing serialized durable writes and the graceful-quit handshake.
It adds no engine/tool capability and does not claim missing notification delivery surfaces.

Rows recheck current scope, callback and owner before opening. Closing unmounts the settings
body immediately despite the dialog exit animation; reopening waits for previously admitted
writes. The board/chat stay mounted under the modal and visible-chat read behavior is paused.
Closing returns focus to the previous chat composer or workspace control. Quit blocks new
navigation and settles admitted preference/draft writes.

Root owns all automated checks, packaging and Mac QA. The planned native check exercises both
entry points, exact coworker/default rules, Escape, a real Codex reply, separate drafts, full
restart persistence and recovery-backed cleanup without changing the original 23 chats / 88
messages. B5 remains partial; the catalog stays at 26 unfinished groups.
