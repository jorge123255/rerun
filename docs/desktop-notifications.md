# Desktop notifications and request age

Original reference: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. Agent C's source handoff was
`b4444f3735b56e36a183d93220152c3fe5135ed8`, based on `927c5e17da6b6db84657261695a98e0533b264de`.
The integration review corrected delivery admission, failure classification, ownership and lifecycle
behavior described below. These are source changes and authored regressions; root owns all checks,
packaging and native acceptance. This document does not claim those checks have passed.

## Original code and design

The preferences reuse `ScopeRadioList`, `SettingsSection`, `CoworkerRules`, the contracts'
`notificationPrefsPatchSchema`, `mergeNotificationPrefs`, `coworkerRuleOf` and `taskNotifies`.
Sources are `components/notifications/settings/`, `components/dialogs/NotificationsDialog.tsx`,
`lib/notifications/prefs.ts` and `packages/contracts/src/notifications.ts`.

`lib/notifications/push-copy.ts` supplies the copy hierarchy: coworker, state/task, short detail.
Successful runs say **Done** and are silent. Failures say **Failed**; questions and approvals use
their original urgent labels. Canceled or contradictory terminals never become notifications.
The original sound asset is `/sounds/notification.mp3`. `useInboxAnnouncer`,
`lib/notifications/announcement.ts` and `WorkspaceInbox` are the original delivery/navigation
references. This Mac slice pairs the native notification surface with a local in-app toast; their
receipts remain separate. The native channel is labeled **Desktop notification**.

The settings keep the original scopes, channel rows and per-coworker rules, with a local roster
picker. Hosted email, cloud push and account-email settings are omitted. Preference patches merge
under the roster write lock, including automated-task owner-follow, so concurrent independent
changes cannot overwrite one another. Settings writes serialize across remounts, hold Quit
admission until their bounded response settles, and show a save error on failure.

## Request age

`findDesktopQuestion` / `findDesktopApproval` in contracts capture the source request message's
`createdAt` as optional `requestedAt`. The desktop question/approval resolvers and attention
projection carry it unchanged. Actions and board activity order/age use
`requestedAt ?? updatedAt`; `updatedAt` retains its existing chat-activity meaning.
Request identity, pending read receipts and multiple requests per chat are unchanged.

## Durable delivery

`lib/desktop/server/notifications.ts` owns these local app-database tables:

- `desktop_notification_prefs`: normalized original preference shape.
- `desktop_notifications_state`: one initial cutoff, initialized before the engine starts.
- `desktop_notifications_seen`: confirmed delivered identities, without age-only pruning.
- `desktop_notification_attempts`: durable admission token recorded before native display.
- `desktop_notification_terminals`: explicit failed terminals pinned to local **and** engine
  coworker/chat identities. Terminal IDs include their local owner and chat. Existing unpinned
  legacy records fail closed. Failure detail expires after 30 days; consumed identities do not.

The event projection combines completions, exact pending requests and failed terminals under the
original scope/follow rules, subtracting pre-install history, seen keys and admitted keys. Genuine
successes remain on the completion store. Automated task owner-follow preserves explicit mute,
follow and task-level choices.

The authenticated routes use `desktopRoute`:

- `GET/PUT /api/desktop/notifications`: authoritative preferences / merged patch.
- `GET /api/desktop/notifications/events`: eligible event snapshot and channel flags.
- `POST /api/desktop/notifications/admit`, `{keys}`: at most 50 eligible identities; returns
  `{events:[{...event,attemptId}],channels}` after atomic durable admission.
- `POST /api/desktop/notifications/delivery`, `{key,attemptId,status,inAppStatus,nativeStatus}`:
  settles the exact token and keeps the local toast result separate from OS acceptance. Older
  receipts containing only `{key,attemptId,status}`, including aggregate `shown`, remain valid.
- `GET /api/desktop/notifications/terminals/[id]`: live, exact failure owner/chat binding.
- The existing `/seen` endpoint remains a compatibility acknowledgment adapter; new delivery
  uses admission and exact token receipts.

Mutation bodies are byte bounded (40,000 bytes) and time bounded. Aggregate `accepted` or legacy
`shown` moves an owned attempt to the seen ledger. Definite aggregate `unavailable` / `failed`
removes only that attempt for retry. Aggregate `unknown` retains admission. A lost receipt, process
exit or ambiguous IPC result also retains admission. A failed or unknown `nativeStatus` does not
erase a separately successful in-app toast. Sound counts as delivered only after playback starts;
Done never rings.

Native `accepted` means only that macOS accepted the notification for presentation. It is not proof
of a visible banner, Notification Center entry, human acknowledgement or click; screen sharing,
Focus and other final OS filtering remain outside this receipt. This is deliberate at-most-once
admission across restart, not exactly-once OS display. An interrupted attempt can remain unshown.

The mounted delivery polls every three seconds, admits only events with an available requested
channel, and suppresses the open conversation only while the document is visible. A hidden Mac
window can still announce. Request lifetimes and native response waits are bounded. Native
notifications always use `silent:true`; the original renderer sound is the sole sound channel.

## Click safety

Clicks never approve, answer or mark read. Pending clicks re-read exact request kind, identity,
owner and chat. Failure clicks verify the pinned binding still equals the clicked owner/chat.
Completion clicks require the original chat still belongs to the same folded group and open that
chat, even if a newer run has changed the group's newest chat. Deleted/rebound/stale targets land
nowhere. A superseded click, unmount, timeout or Quit cannot navigate after a late response.
A click that arrives before the board subscribes, or while `/desktop` is reloading, stays in a
main-process queue of at most eight targets bound to the current workspace id and launch nonce.
The existing `onNotificationClick` subscription reports readiness, and that same target is then
sent once on `desktop:notification-click`. A different workspace or launch nonce is dropped.
Permission, display-sharing suppression, and a click from a previous app process stay outside
this queue (`docs/desktop-next-f-notification-ready-handoff.md`).

## Root integration contract

Initialize `initializeDesktopNotifications(db)` from database startup before engine runs. For an
automated chat, adopt its engine session into the local chat store **before** calling
`recordDesktopRunTerminal`; missing local ownership fails closed. Do not wrap this helper in an
outer roster lock: it owns that serialization itself.

Mount `DesktopNotificationDelivery` once under `DesktopApp`, passing the current visible local
session and the root's guarded `onOpenConversation` callback. Settings' Notifications panel mounts
`DesktopNotificationSettings`.

The narrow native bridge contract is:

```ts
notifications: {
  notify(payload): Promise<{status: 'accepted' | 'unavailable' | 'failed' | 'unknown'}>
  onNotificationClick(listener): () => void
}
```

The payload is `{key,kind,agentId,sessionId,groupId?,terminalId?,requestId?,title,subtitle?,body?,silent}`.
The main process must verify the trusted owned window/frame/origin, validate bounded fields, and
construct Electron `new Notification({title, subtitle, body, silent:true})`. `accepted` requires the
native show event and reports OS acceptance only; an older bridge's `shown` response normalizes to
`accepted`. Unsupported means `unavailable`; definite nondelivery means `failed`; timeouts and IPC
ambiguity mean `unknown`. Root's native bridge deduplicates by key as an additional guard, holds a
click until the current desktop page has subscribed, then routes that target once to the trusted
window, shows/focuses it, and refuses delivery after quit is committed. Blanket renderer permission
denial remains unchanged.

## Authored coverage and limits

`app/api/desktop/notifications/route.test.ts` covers preference merging, scope/follow/cutoff,
error/canceled classification, owner-pinned terminals, concurrent admission, exact-token retry,
restart suppression, old seen keys, authentication and actual body limits.
`DesktopNotificationDelivery.test.tsx` covers lost receipts/remount, separate in-app/native results,
accepted, failed, unavailable and ambiguous bridge results, legacy native `shown`, sound-only
delivery, visible/hidden behavior and stale/cross-owner click guards.
`DesktopNotificationSettings.test.tsx` covers original composition, authoritative saves, failed
saves and Quit admission. Attention's route regression covers request age independent of session age.
`apps/desktop/test/notification-click-handoff.test.mjs` covers a click held before subscription and
across reload, one exact delivery, a stale workspace or launch nonce, the queue bound, duplicates,
malformed targets, quit, and diagnostics without notification copy. That fixture was authored and
not run by the readiness lane.
Root must run these and the shell tests, then verify real notification permission, actual native
display/sound/click behavior, settings persistence and no replay after a full restart.

This slice does not add hosted email/cloud push, a coworker-tile bell or a task-level “Notify me”
editor. The local in-app toast is not evidence of OS banner visibility. The delivery consumes the
existing bounded completion/attention projections; it is not a historical notification backfill.
Seen/admission identities are retained while their sources can remain; no unsupported exactly-once
delivery guarantee is made.
