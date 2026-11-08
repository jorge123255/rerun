# Desktop coworker overview handoff

Source only. Not validated. No installed acceptance. Do not merge, deploy, or release.

## Pins

| | |
|---|---|
| Repository | `https://github.com/jorge123255/rerun` |
| Published base | `desktop/finish-cloud-base-20261106-8297fe64` |
| Base SHA | `8297fe6404caa114dcb0c2cd6006291a8abb2038` |
| Branch | `cursor/desktop-ui01-coworker-overview-dbba` |
| Implementation commit | `8f1c906f658dbaa2d4f054d065c388e2204836c8` |
| Tip | the stamp commit that records this implementation hash. `git rev-parse HEAD` on this branch is that tip. |
| Official overview | `2a57fa6dd53311f763bfc9abde85997b7f7e5309` and `ab3def9bfcf545cc9548f99c63c2b011ca094023` share the same blobs: `agent-sheet-views.ts` `45a7410f11f68fb6c350043703786ce5a60c32fb`, `AgentCard.tsx` `04cdd5a80091eb21c2e4468e6907a1ac71fd1f22`, `AgentView.tsx` `92f292513d3d94b205de89877ac4ef37af68faf2`, `AgentPanel.tsx` `152bf246f8c80c65586d84e40dd48d01b21620a0` |
| This base’s copies | `AgentPanel.tsx` matches. `agent-sheet-views.ts`, `AgentCard.tsx`, and `AgentView.tsx` do not. Those shared files were not edited. |

The mounted original is `AgentPanel` → `AgentCard` → `AgentView` / `AgentViewExpander`. The card destinations are Apps, Skills, Knowledge, Routines, then Files and Database, then the computer, then Activity and Settings, then Delete this coworker. Screens group Apps/MCP, Routines/Scheduled+Triggers, Activity/Monitoring+Logs, and Settings/General+Capabilities+Install. Files also has Published. Install is hidden unless the viewer is the template author. Published is hidden unless publication access is on. A hidden tab lands on the screen’s first tab.

## Changed paths

- `apps/ui/lib/desktop/coworker-overview/**`
- `apps/ui/components/desktop/coworker-overview/**`
- `docs/desktop-finish-coworker-overview-handoff.md`

No edits to `DesktopApp`, `DesktopConversation`, the composer, navigation mounts, grants, contract barrels, the migration ladder, canonical stores, Control Center, API settings, Files, Memories, Settings, Schedules, Tools, or `fx-repairs`.

## Production binding

| Surface | Binding |
|---|---|
| Identity | Caller passes `ownerId`, `workspaceId`, and `agentId`. A mismatched agent id shows “This coworker’s owner is unavailable.” Changing the identity key closes the open screen. |
| Box | Caller passes the active workspace’s boxes. A missing list, a missing space, or a space outside that list shows “This coworker is not in this workspace.” An empty name uses `Untitled Box`. |
| Name | `PATCH /api/desktop/agents/:id` with `{ name }`, the existing rename route. The response is kept only when the agent id and name match the request and the identity has not changed. A failed or uncertain response restores the previous name and does not send again. |
| Box manager | `canManage` defaults to null. Rename, Share, and Delete then use “Only an admin or a manager of this Box can change this”. This package does not invent an admin grant. |
| Bell | Existing `DesktopCoworkerNotificationControl`. |
| Share / Delete | Stay closed unless the parent passes `onShare` or `onDelete`. Delete uses the existing `DeleteCoworkerConfirmation` and does not call `DELETE` itself. |
| Computer | Shown only when `computerEnabled` is true. No `openDesktopAction`. A closed or missing screen says the computer is not open. A dropped live socket says “The screen went away” and does not reconnect. |
| Apps dot | Shown only when `servicesNeedConfig === true`. |
| In-place sections | Apps `DesktopCoworkerServices`, MCP `DesktopCoworkerMcp`, Skills `DesktopAgentPanelSkills`, Routines `DesktopCoworkerSchedules`, Triggers `DesktopCoworkerTriggers` with `ingressAvailable={false}`, Activity `DesktopCoworkerMonitoringBody`, Install `DesktopAgentPanelSetup` only when `installAuthor` is true. |
| Accepted panels | Files, Knowledge, Database, General, Capabilities, and Logs are not copied. The screen says they stay in the accepted panel and calls `onOpenAcceptedPanel` only when the parent provides it. |
| Published | Hidden unless `publishedAccess` is true. The visible body says it is not available on this Mac. No publication request is made. |
| Workspace switch | `guardDesktopOverviewWorkspaceSwitch` decides only. Same workspace is a no-op. A different workspace requires idle run status, `{ saved: true }` for the same owner and current workspace, no switch in flight, and no quit. It does not call `switchTo`, stop a run, or retry. |
| Loading | Renders `loadingSlot` when the parent passes one. Otherwise the status line is “Loading this coworker…”. No panel skeleton is mounted. |

## Root mount fragment

Integration mounts `DesktopCoworkerOverviewRootMount` from `apps/ui/components/desktop/coworker-overview/root-mount.tsx`. This branch does not insert it. The conversation card that still launches flat dialogs is `DesktopConversation.tsx` around the “Coworker details” section. The replacement, owned by integration, is:

```tsx
<DesktopCoworkerOverviewRootMount
    identity={{ ownerId: String(profile.id), workspaceId: runtimeWorkspaceId, agentId: agent.id }}
    agent={agent}
    boxes={boxesOfActiveWorkspace}
    canManage={runtimeWorkspaceId === identity.workspaceId ? true : null}
    phase={boxesOfActiveWorkspace ? 'ready' : 'loading'}
    servicesNeedConfig={servicesNeedConfig}
    settingsDisabledReason={generating ? 'This coworker is replying.' : null}
    working={generating}
    loadingSlot={loadingSlot}
    onOpenSession={(sessionId, title) => onSelectSession(sessionId)}
    onOpenAcceptedPanel={panel => dialogControl(panel).onOpenChange(true)}
    onClose={dismissCard}
    onRenamed={(next, name) => { if (next.agentId === agent.id) replaceAgentName(name) }}
/>
```

`profile` and `runtimeWorkspaceId` are the DesktopApp values that already exist. The conversation does not have them today; integration passes them in. Do not pass `canManage: true` for a workspace that profile does not own. Pass `publishedAccess` only from the real publication flag. Pass `installAuthor` only for the template author. Pass `computer` only from a screen that is already open. Call `guardDesktopOverviewWorkspaceSwitch` before any existing workspace switch while this overview is showing, and do not switch when `ok` is false.

## Unrun regressions

`apps/ui/lib/desktop/coworker-overview/coworker-overview.test.ts` covers card order, official groups, hidden Install and Published, sibling rejection, focus movement, workspace stay/switch/refusal, box resolution, the Apps dot, and rename identity. It was not executed.

## Checks not run

Tests, typecheck, lint, build, install, UI, browser, native, provider, database, and network were not run.

## Still gated

- The overview is not mounted in `DesktopConversation` or `DesktopApp`.
- Files, Memories, Database, Settings, Capabilities, and Logs still open their accepted panels only through the parent callback.
- Share and delete do nothing until the parent passes the existing handlers.
- Computer watch is not started here.
- Published and public trigger ingress stay unavailable.
- Workspace switching is a decision, not a switch.
- Rename does not retry an uncertain response.
- No claim that every original section action is installed or accepted.
