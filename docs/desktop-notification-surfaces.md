# Desktop notification surfaces

The in-app half of the local notification slice: the original toast card, the coworker bell and
the routine « Notify me » switch, all backed by the durable local preferences route instead of
the hosted users row. Native OS delivery, admission/attempt receipts and click revalidation are
described in `desktop-notifications.md`; this file covers only the visible surfaces.

## Pieces

- `lib/desktop/use-notification-prefs.ts` — `useDesktopNotificationPrefs()`, the desktop twin of
  `useNotificationPrefs`: same `{ prefs, update, setCoworkerRule, ruleOf }` shape, same
  pending-merge optimistic updates and one-write-at-a-time queue, persisted through
  `GET/PUT /api/desktop/notifications`. One zustand store is shared by every mounted surface, so
  the bell, the task switch and the settings dialog agree between writes. Failed writes revert
  the optimistic value and raise a sonner error toast. `ready` requires a successful stored read; the bell and task switch stay disabled while the initial read is unknown. Read failures offer Retry. Settings now uses this same store and queue; stale reads cannot overwrite later acknowledgements, and an earlier failed write cannot drop a later pending patch.
- `lib/desktop/notification-click.ts` — `resolveDesktopNotificationClick(target, signal)`, the
  single revalidation used by native clicks and in-app toast opens: completions re-check the
  group still contains the recorded session, terminals re-check the pinned local owner/session
  binding, requests re-check the exact pending item. Stale, deleted or rebound targets resolve
  to `null` and navigate nowhere.
- `lib/desktop/notification-toast.tsx` — `showDesktopNotificationToast(event, onOpen)`, the
  original `NotificationToast` card via `toast.custom`, id `desktop-notification:<key>` so a
  remount cannot announce one admission twice. Scheduled sources get the `CalendarClock` icon,
  violet tint, brand beam and « · Scheduled task » title suffix; other kinds reuse
  `KIND_ICONS`/`KIND_ICON_COLORS`/`KIND_BEAM`. « Open conversation » dismisses and enters the same cancellable revalidation pipeline as native clicks; superseded reads, unmounted delivery and Quit cannot navigate late. The event now carries `source` so the scheduled treatment survives the
  trip from server projection to toast.
- `components/desktop/DesktopCoworkerNotificationBell.tsx` — `CoworkerBellMenu` with its original rows and styling, wired
  to the local prefs. The scheduled-task count is fetched lazily on open from
  `/api/desktop/coworkers/<id>/schedules`; desktop has no trigger surface, so the count is
  schedules only (the original counts schedules plus triggers). Counts are bounded and owner-keyed, and failure is displayed as unavailable rather than an invented zero. The shared menu gains optional disabled/unavailable flags that leave hosted callers unchanged.
- `components/desktop/DesktopTaskNotifyField.tsx` — verbatim port of `TaskNotifyField`
  (`Field` + `Switch` + `TooltipDisabledReason`), bound to `taskKey(agentId, source, slug)`.
  Renders nothing for an empty slug, so mount it only for saved tasks.
- `useDesktopNotificationDelivery` — admitted events under the toast channel now show the
  in-app card in addition to the native alert; the native payload stays `silent` and the
  original sound asset remains the only ring. The in-app card needs no Electron bridge, so a
  missing bridge no longer swallows toast-channel events: they admit, toast and settle `shown`.
  Sound-only admissions still deliver through `playSound`; a sound failure reports
  `unavailable` and stays retryable. Native delivery status no longer feeds the receipt once
  the in-app card has shown — an ambiguous native outcome cannot unsend what the user already
  saw.

## Root-owned integration fragments

Mount the card control in `DesktopConversation` (the `cardOpen` section beside the existing action buttons). The control owns its pinned settings dialog; opening it does not create a coworker rule:

```tsx
<DesktopCoworkerNotificationControl agentId={agent.id} name={agent.name} />
```

The task switch is now mounted inside the schedule editor for a saved task only (and disabled while a task operation is pending):

```tsx
{task?.slug ? <DesktopTaskNotifyField agentId={agentId} source="schedule" slug={task.slug} /> : null}
```

`DesktopNotificationDelivery` already supplies `onOpenConversation`; the toast reuses the same
navigation callback, so no extra wiring is needed there. Settings, the bell and task switch now share one preference store and write queue. Root must mount the delivery component even when the native bridge is unavailable, because the in-app toast still works.

## Known differences from hosted

- Scheduled count excludes triggers (no desktop trigger surface).
- Toast and native share the single `toast` channel, matching the original where one preference
  drove both the in-app announce and the browser notification.
- Hosted email/cloud push rows stay absent, as before.

## Root execution boundary

Integration fixes and regression cases were authored without executing tests, type checks, lint, builds, packaging, or the Mac app. Root owns all execution and native/restart acceptance. New regressions cover failed initial reads, shared surface freshness, stale GET versus newer PUT, retained later optimistic patches, Strict Mode and old-owner counts, plus shared native/toast click cancellation.

## Root native acceptance — November 5, 2026

On installed `adfb47d`, coworker All activity and the paused task’s Notify me off preference persisted through full restart. A background completion toast displayed actual shared/private file results. Clicking Open conversation on a subsequent error toast opened the exact owner/session without answering its sibling approval. The original in-app surfaces are accepted. Actual macOS notification banner display/click remains unobserved and is not covered by this acceptance.
