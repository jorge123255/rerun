# Desktop notification preferences, local delivery and request age (lane handoff)

Ports Rerun's per-coworker notification choices (C7 scope, channels, per-coworker rules) and
local desktop delivery for genuine completed runs and unanswered question/approval requests,
plus the pending request age/order fix. Source-only lane — the integration owner runs all
validation and Mac testing.

Base: `927c5e17da6b6db84657261695a98e0533b264de`. Branch: `desktop/coworker-notifications`.

## Request age and order fix

- `packages/contracts/src/desktop-question.ts` / `desktop-approval.ts` — `findDesktopQuestion` /
  `findDesktopApproval` capture the source request message's `createdAt` as `requestedAt` on the
  pending request (the row types gain an optional `createdAt`, the types an optional
  `requestedAt`). Additive: existing callers are unaffected.
- `apps/ui/lib/desktop/questions.ts` / `approvals.ts` — the pending view schemas carry the
  optional `requestedAt`.
- `apps/ui/lib/desktop/server/questions.ts` / `approvals.ts` — the resolvers thread the source
  message's timestamp through.
- `apps/ui/lib/desktop/attention.ts` / `server/attention.ts` — the attention item carries
  `requestedAt` (the request message's timestamp, falling back to the chat's latest activity
  only when the request carries none), and the projection sorts newest request first. The
  `updatedAt` field keeps the chat's latest activity, so nothing else changes meaning.
- `apps/ui/components/desktop/DesktopActionsInbox.tsx` — the row's age and the list order use
  `requestedAt ?? updatedAt`.
- `apps/ui/lib/desktop/board-activity.ts` — `latestBoardAttention` orders by
  `requestedAt ?? updatedAt`.
- `apps/ui/app/api/desktop/attention/route.test.ts` — an authored regression: two pending
  requests whose sessions were created in the opposite order still order by the request
  message's timestamp, and each item carries its own `requestedAt`.

Request identity, per-row and bulk read receipts and the multiple-requests-in-one-chat
semantics are untouched: the fix only replaces the timestamp source.

## Notification preferences

- `apps/ui/lib/desktop/server/notifications.ts` — the durable local adapter, owning its tables:
  - `desktop_notification_prefs` (one row per workspace, the normalized v2 prefs JSON from
    `@rerun/contracts`);
  - `desktop_notifications_state` (one install-time cutoff, seeded on first use: everything
    raised before the slice's first boot is old history that never replays as new);
  - `desktop_notifications_seen` (the announced event keys, pruned to a month on acknowledge).
  `readDesktopNotificationPrefs`/`writeDesktopNotificationPrefs` normalize and merge with the
  original `notificationPrefsPatchSchema` + `mergeNotificationPrefs`, so a surface that only
  touches one field never clobbers the rest.
- `apps/ui/app/api/desktop/notifications/route.ts` — `GET` the authoritative prefs, `PUT` the
  original patch (validated by the contracts' schema), both through `desktopRoute`.
- `apps/ui/components/desktop/DesktopNotificationSettings.tsx` — the original composition:
  `ScopeRadioList`, the « How » channel rows (only the two local channels: the in-app toast via
  the native bridge and the sound; hosted email/cloud push is not rendered and not delivered)
  and `CoworkerRules` with a local-roster picker. The coworker picker avoids the hosted board
  store: it reads `/api/desktop/agents` and renders the same « Choose a coworker » wording. The
  component serializes its writes like the original settings queue and replaces its optimistic
  value with the authoritative merged response.
- `apps/ui/components/desktop/DesktopSettings.tsx` — the panel list gains `Notifications` and
  the tab renders the component. (This file is shared; the edit is the panel entry, nothing
  else.)

## Events, delivery and clicks

- `apps/ui/lib/desktop/server/notifications.ts` — `readDesktopNotificationEvents` composes the
  completions and attention projections with the stored prefs: scope « nothing » announces
  nothing, a muted coworker never announces, « everything » announces every coworker, and the
  remaining scopes follow the original rules (`taskNotifies` for scheduled runs, runs the user
  started under « mine », questions/approvals always reaching the local user). The install
  cutoff and the seen ledger subtract whatever already announced.
- `apps/ui/app/api/desktop/notifications/events/route.ts` — `GET` the events (newest first) with
  the channel flags; `apps/ui/app/api/desktop/notifications/seen/route.ts` — `POST` the
  acknowledged keys, recorded only after the delivery announced them.
- `apps/ui/lib/desktop/notification-bridge.ts` — the narrow bridge wrapper: it reads
  `window.desktopApp.notifications` (`notify` + `onNotificationClick`) and never touches the
  blanket renderer-permission policy.
- `apps/ui/components/desktop/useDesktopNotificationDelivery.ts` /
  `DesktopNotificationDelivery.tsx` — the delivery controller (renders nothing): it polls the
  events every three seconds visible or not, announces `toast` events through the bridge and
  plays the original sound only for what needs the user, acknowledges after announcing, skips
  the visible conversation's own events until it can announce them, and routes clicks through a
  live revalidation: a done click re-reads the completions and opens the group's newest
  conversation; a question/approval click re-reads the attention projection and opens the
  still-pending request. Nothing is ever answered, marked read or navigated blind.
- `apps/ui/components/desktop/DesktopNotificationDelivery.test.tsx`,
  `apps/ui/components/desktop/DesktopNotificationSettings.test.tsx` and
  `apps/ui/app/api/desktop/notifications/route.test.ts` — authored regressions (not executed in
  this lane): scope/coworker filtering, channel suppression, the install cutoff, acknowledge
  dedup across restart, object-URL-free click revalidation, the original push copy
  (who → where/what → detail, silent for `done`), and the pending-request timestamp fix.

Upstream reviewed at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/notifications/settings/NotificationChannels.tsx`, `ScopeRadioList.tsx`,
  `SettingsSection.tsx`, `CoworkerRules.tsx`, `scope-meta.ts`, `CoworkerNotificationSettings.tsx`
  (reused verbatim where the Mac carries the channel; the email rows are omitted)
- `apps/ui/components/dialogs/NotificationsDialog.tsx` (composition and picker wording)
- `apps/ui/lib/notifications/prefs.ts` and `packages/contracts/src/notifications.ts`
  (scope/channel/coworker rules, patch schema and merge)
- `apps/ui/lib/notifications/push-copy.ts` (the OS notification copy: who, then where and what)
- `apps/ui/hooks/useInboxAnnouncer.ts` + `lib/notifications/announcement.ts` (delivery pacing
  reference; the Mac announces through the OS surface instead)
- `apps/ui/components/notifications/WorkspaceInbox.tsx` (row folding, Done grouping and the
  never-answered navigation semantics)

## Integration steps for root

1. **Native bridge (shell, additive).** In `apps/desktop/src/main/preload.cjs`, extend the
   exposed `desktopApp` bridge with:

   ```js
   notifications: {
       notify: payload => {
           if (!payload || typeof payload.key !== 'string' || typeof payload.title !== 'string') return
           ipcRenderer.send('desktop:notify', {
               key: payload.key, kind: payload.kind, agentId: payload.agentId,
               sessionId: payload.sessionId ?? null, groupId: payload.groupId ?? null, requestId: payload.requestId ?? null,
               title: payload.title, subtitle: payload.subtitle ?? undefined, body: payload.body ?? undefined, silent: payload.silent === true,
           })
       },
       onNotificationClick: listener => {
           if (typeof listener !== 'function') throw new TypeError('Expected a notification click listener')
           const handler = (_event, target) => listener(target)
           ipcRenderer.on('desktop:notification-click', handler)
           return () => ipcRenderer.removeListener('desktop:notification-click', handler)
       },
   },
   ```

   In `apps/desktop/src/main/index.mjs`, beside the existing IPC handlers:

   ```js
   ipcMain.on('desktop:notify', (_event, payload) => {
       if (!payload || typeof payload.key !== 'string' || typeof payload.title !== 'string') return
       const notification = new Notification(payload.title, {
           subtitle: payload.subtitle, body: payload.body ?? '', silent: payload.silent === true,
       })
       notification.on('click', () => {
           notification.close()
           for (const window of BrowserWindow.getAllWindows()) {
               window.webContents.send('desktop:notification-click', {
                   key: payload.key, kind: payload.kind, agentId: payload.agentId,
                   sessionId: payload.sessionId ?? null, groupId: payload.groupId ?? null, requestId: payload.requestId ?? null,
               })
           }
       })
       notification.show()
   })
   ```

   The blanket permission policy (`setPermissionRequestHandler`/`setPermissionCheckHandler`)
   stays exactly as it is: the OS notification is raised by the main process, never by the
   renderer, and no permission is requested from the UI.

2. **Delivery mount (DesktopApp, root-owned).** Mount once inside the app root:

   ```tsx
   <DesktopNotificationDelivery
       onOpenConversation={target => { if (currentAgents.current.some(agent => agent.id === target.agentId)) selectCoworker(target.agentId, target.sessionId) }}
       visibleSessionId={visibleSession?.agentId === selectedAgentId && panelOpen ? visibleSession.sessionId : null} />
   ```

   The component renders nothing; it only polls, announces and routes clicks.

3. **Storage (database/bootstrap, root-owned).** No central edit is required: the slice's
   tables are created lazily by `initializeDesktopNotifications` on the same pooled client.
   If the bootstrap should carry the prefs, read them with
   `readDesktopNotificationPrefs(await openDesktopDatabase(runtime.dataRoot))` and add the
   result to the parallel reads.

4. **Settings entry (already wired).** `DesktopSettings`' `Notifications` panel mounts
   `DesktopNotificationSettings`; no further integration needed.

## Known limits

- Checks and Mac acceptance were not run by this lane: tests, type checks, lint, builds,
  packaging and the native notification behavior belong to the integration owner. The authored
  regressions live in the three test files.
- Hosted email/cloud push never delivers; the original email rows and the account-emails tab
  are omitted, and the stored prefs keep the contracts' shape with `email` unused.
- The in-app toast above the inbox is not ported this round: a `toast` preference announces
  through the OS surface, which is the only local surface wired so far. The « Sound » row keeps
  its original copy; error runs are outside this slice's events, so the sound only covers
  questions and approvals.
- A scheduled task's « Notify me » switch is not ported: scheduled runs follow the stored
  `tasks` ledger through the original `taskNotifies` rules, but no surface edits a task's own
  switch yet.
- The coworker bell is not ported to the desktop tiles; per-coworker rules are managed from
  Settings' `Per coworker` section only.
- A delivery whose native bridge is missing degrades to the sound only; the event is still
  acknowledged, so it does not replay after restart.
- The seen ledger keeps acknowledged keys for a month; a key could re-announce if the same
  event identity reappeared after that month, which the completions cutoff prevents for
  finished runs and the request identity prevents for pending requests.
