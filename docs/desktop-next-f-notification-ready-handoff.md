# F — Notification click through renderer readiness

Parent: aff68bebd97380edb3a70424bd2a7ff212affaab
Branch: desktop/next-f-notification-ready-handoff
Worktree: /Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-f-notification-ready-handoff

## Verified gap

`createNotices` sent `desktop:notification-click` only when the window was already on `/desktop`. The preload registered `ipcRenderer.on('desktop:notification-click')` only inside `onNotificationClick`, which `useDesktopNotificationDelivery` calls when the board subscribes. Electron does not queue that send for a listener that is not registered yet. A click before that subscription, or during a reload while the page is not `/desktop`, was dropped. `did-start-navigation` also bumps `rendererEpoch`, so a fire-and-forget send cannot be retried against the next board.

`resolveDesktopNotificationClick` was not the loss. It still re-reads the live completion, terminal, or attention item and returns null for a stale, deleted, or rebound target. Clicks still never approve, answer, or mark read.

## Repair

The main process holds at most eight clicks for the current `workspaceId` and `launchNonce`. Same-workspace reload keeps the queue: `launchNonce` does not change. A different workspace (`stale-workspace`) or a new launch nonce (`stale-runtime`) is dropped. A missing runtime does not clear the queue. A duplicate key for the same binding is dropped. A full queue drops another scope first, otherwise the oldest held click (`queue-bound`).

The preload adds the click listener, then sends `desktop:notification-clicks-ready` with its `registrationId`. Unsubscribe sends `desktop:notification-clicks-unready`. The main process ignores an untrusted frame. It sends the original target once on the existing `desktop:notification-click` channel only when that registration's web contents are the current `/desktop` page. A refused send stays held. A delivered key is not sent again. Navigation clears the subscriber and does not put a delivered key back.

A cancellable quit does not deliver. The committed quit drops held clicks (`quitting`). Diagnostics keep outcome, reason, key, workspace id, and session id. They do not keep title, body, or other notification copy.

Permission denial, display-sharing suppression, and a click on a banner created by a previous app process are separate questions. This lane does not answer them and does not change OS settings.

## Seam

Native `notice.once('click')` → `notificationClickTarget` → `createNotificationClickHandoff` → preload `onNotificationClick` ready signal → `desktop:notification-click` → `desktopNotificationsBridge().onClick` → `useDesktopNotificationDelivery` → `resolveDesktopNotificationClick` → `onOpenConversation`.

## Fixture

`apps/desktop/test/notification-click-handoff.test.mjs` is a deterministic startup and reload fixture. It covers a click held while delivery is refused, one later delivery of the same session, no second delivery, a dropped workspace, a dropped launch nonce, the eight-item bound, a duplicate key, a malformed target, quit, and diagnostics without notification copy. This lane authored it and did not run it. Root runs `pnpm --dir apps/desktop test` with the existing notification shell tests.

## Physical signed-app recipe

Root owns this pass. Do not change Notification Center, Focus, permission prompts, or display sharing.

1. From a clean checkout of this commit, build the signed preview with `pnpm desktop:package`. Do not use a generic Electron launch as evidence of a banner click.
2. Run `node scripts/desktop/verify-notification-preview.mjs` on that `.app`. If the check fails, record native click-through as blocked.
3. Open the signed app. Leave the current notification settings as they are.
4. Trigger one existing native notification for a known coworker chat. Click the banner while `/desktop` is still loading, or before the board paints. After `DesktopNotificationDelivery` subscribes, that same chat opens once.
5. Reload the same workspace and click a banner during the reload. After the board returns, that chat opens once. A second click of an already delivered key does not navigate.
6. Switch workspace. A banner bound to the previous workspace or launch nonce does not open a chat in the new one.
7. Record permission denial, a banner hidden by display sharing, and a click on a banner left by a previous app process as separate questions. Do not treat them as failures of this handoff.
