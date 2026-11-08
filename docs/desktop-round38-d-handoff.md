# Desktop Round 38 — Agent D handoff (tool presentations)

Source only. No tests, typecheck, lint, build, install, server, packaging, Docker, Keychain, live provider, or app launch was run. Nothing here is accepted. `docs/desktop-parity-checklist.md` was not changed.

Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round38-d-tool-presentations`  
Branch: `desktop/round38-d-tool-presentations`  
Base: `6f6ad959a09abaf1947950b6f82413c94407e22a`  
Original pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`  
Upstream read: `2a57fa6dd53311f763bfc9abde85997b7f7e5309` in `upstream-review-20261106`  
Implementation: `a143b8c8087afa56f2ac32363595da5934662be1` (`feat(desktop): show historical tool outcomes without rerunning them`)

This file is not that commit. The package is not mounted.

## Residual inventory

A generic `DesktopToolStep` is already the desktop row for an ordinary tool. These originals already have a desktop presenter and were not ported again:

| Original | Desktop presenter | Decision |
| --- | --- | --- |
| `FileCard` / `card_file` | `DesktopFileCard` | kept |
| `TableCard` / `card_table` | `DesktopTableResult` | kept |
| Media inside the file card | `DesktopFileCard` image, video, audio, PDF | kept |
| Computer / screen | `DesktopComputerPanel`, `ScreenCard`, isolated screen | kept, outside the reply loop |
| `SubRunBlock` / `delegate_tasks` / `call_agent` | `DesktopDelegationMount`, `DesktopCoworkerCalls` | kept |
| `ApprovalBlock` | `DesktopApprovalCard` | kept for a live approval. A historical `approval-requested` must not mount it |
| `SkillProposalBlock` | `DesktopSkillProposalBlock` | kept |
| `BrainProposalBlock` | `DesktopBrainProposalBlock` | kept. Its mode stays `"edit"` |
| `SetupCompleteCard` / `install_complete` | `DesktopSetupCompleteCard` | kept |
| `tool_install` | `DesktopToolInstallCard` | kept |
| `ScheduledRunBlock` / `WebhookRunBlock` / install divider | `DesktopScheduledRunBlock`, `DesktopWebhookRunBlock`, `DesktopInstallBlock` | kept on `DesktopConversation` |
| Reasoning summary, compaction, sources, quick replies | existing reply branches | kept. Questions, quick replies, transcript fidelity, and chat recovery stay with RD37 |
| `NotificationCard` | `DesktopNotificationCard` in `setup/DesktopSetupEventCards.tsx` | unwired, and it does not redact or read an acknowledgement. Not the historical adapter |

Concrete residuals, now in `apps/ui/components/desktop/tool-presentations/`:

1. A delivered `notify_user` card. Desktop was falling through to `DesktopToolStep`.
2. A frozen `mcp_register` / `mcp_login` outcome. The hosted `McpServerCard` refetches connectors and can open Connect.
3. A read-only brain change for `brain_write`, `brain_delete`, and `brain_decide`. The hosted `BrainChangeBlock` calls `brainChanged()` on mount and Undo calls `revertBrainPageAction`.
4. `projectDesktopToolStatus`: pending, running, succeeded, failed, cancelled, unknown. Lost, unknown, or mismatched identity does not become succeeded.
5. `planDesktopToolPresentation` and `DesktopHistoricalStepGroup` for consecutive leftover generic steps. The hosted `StepGroup` only knows done, error, and running, and `toolStatusOf` maps every other state to running.

## Original path mapping

| Original | Historical adapter |
| --- | --- |
| `apps/ui/components/chat/MessageView.tsx` notify branch | `select.ts` `notify_user`, `DesktopHistoricalNotification.tsx` |
| `apps/ui/components/chat/SetupEventCards.tsx` `NotificationCard` | same copy: "Sent you a notification", message, badge "Read" |
| `apps/ui/components/chat/McpServerCard.tsx` | `DesktopHistoricalMcpOutcome.tsx`. Failed copy "Couldn't connect {name}" and badge "Not added". Saved copy "{name} added" and "Custom MCP server · {host}" |
| `packages/contracts/src/chat-mcp-register-card.ts` `mcpRegisterCardOf` | used as the parser. No second schema |
| `apps/ui/components/chat/BrainChangeBlock.tsx` | `DesktopHistoricalBrainChange.tsx` |
| `packages/contracts/src/brain.ts` `brainChangeOf`, `brainChangeHeadline`, `BRAIN_CHANGE_NOTES` | used as the parser and the copy |
| `apps/ui/components/chat/StepGroup.tsx` | `DesktopHistoricalStepGroup.tsx` keeps "N steps" and "N failed", and adds cancelled, unknown, and pending |
| `apps/ui/components/chat/ToolStepRow.tsx` `toolStatusOf` | not edited. `status.ts` is the projection root can use |

## Unsupported

These stay off this package. A completed part can still project `succeeded` on a generic row because that is the recorded tool state. That projection is not a hosted card.

- `rerun_hub_service_install`, `NeedsAuthCard`, and `ServiceInstalledBlock`. They call the catalog and a sign-in form. `DesktopNeedsAuthCard` already exists and is live.
- `rerun_hub_publish_file` and `PublishedChatCard`.
- `paid_data` and `PaidSourcesPill`.
- Live `McpServerCard` Connect, `McpOAuthAuthorize`, and connector refetch. `DesktopMcpSignInReceipt` remains the separate `request_mcp_sign_in` receipt.
- Brain Undo, `revertBrainPageAction`, and `brainChanged()`.
- Mounting `ApprovalBlock` for a historical `approval-requested`.
- `ask_user`, `suggest_replies`, and the other HITL tools. RD37 and the existing cards own them. The planner marks them passthrough.

## Behavior

- Opening a card or expanding a group does not fetch, send, sign in, undo, or rerun a tool. There is no effect on mount.
- `notify_user` renders only when the status is succeeded, the message is a non-empty string of at most 16,000 characters, and the unwrapped output is exactly `Notification sent to the user.` The hosted view treats any other `output-available` text that merely omits "Notification not delivered" as delivered. This package does not.
- An undelivered sentence, a non-string output, an empty message, or a message over 16,000 characters stays on the generic row.
- MCP renders only from a string output of at most 8,000 characters that `mcpRegisterCardOf` accepts. An object output is not stringified into a saved card. The raw URL is not rendered. The visible host is `URL.hostname` only, so userinfo is dropped. The saved card has no status badge, because the hosted badge refetches and can say Connected.
- Brain renders only when `brainChangeOf` returns a real change and the output is at most 8,000 characters. `undoRevisionId` and `hash` are not kept. Deleted has no Open. Saved, accepted, and dismissed show Open only when root passes `onOpenBrain`. The default does not navigate and does not call `openBrainPage`.
- Displayed strings are redacted, then cut at 2,000 characters with `…`. The redaction covers a private key, `sk-` / `gh*` / `xox*` tokens, Bearer, cookie and authorization headers, password / secret / token / api-key assignments, URL userinfo, and ANSI.
- A tool whose name matches secret, credential, token, oauth, sign-in, or password keeps no detail. A failure says only `Credential request failed.`
- Missing acknowledgement on an ordinary transcript part follows the part state. Explicit `lost`, `unknown`, `null`, `false`, or disagreeing acknowledgements, including `providerMetadata.desktop` and `providerMetadata.rerun`, project `unknown`.
- `cancelled` or `canceled`, on the state or the acknowledgement, projects `cancelled` even when the output is a success sentence.
- `restarted` without acknowledgement `recorded` projects `unknown`. `recorded` after a restart uses the part state.
- A part owner, workspace, or run that disagrees with the caller, or a malformed id, projects `unknown`. The foreign id is not copied onto the group item.
- `approval-requested` and `approval-responded` are pending. The second is not a new tool run. `input-streaming` and `input-available` are running. Preliminary `output-available` is running. `output-error`, `output-denied`, a non-empty `errorText`, and an `error-text` or `error-json` envelope are failed.
- A missing or unrecognized state is unknown.

## Root activation

Do not replace the reply loop. After the existing `call_agent`, `delegate_tasks`, `tool_install`, `install_complete`, `brain_propose`, `skill_propose`, `card_file`, and `card_table` branches in `DesktopAssistantReply`, and before `DesktopToolStep`:

```tsx
import { DesktopHistoricalCardView, selectDesktopHistoricalCard } from '@/components/desktop/tool-presentations'

const historical = selectDesktopHistoricalCard(part, { ownerId: agentId, workspaceId, runId })
if (historical) {
    blocks.push(<DesktopHistoricalCardView key={part.toolCallId} card={historical} onOpenBrain={historical.kind === 'brain-change' && historical.showOpen ? openLocalBrain : undefined} />)
    continue
}
```

`openLocalBrain` may only open the local brain surface. It must not call `revertBrainPageAction`, `brainChanged()`, or a tool. Omit it and the card has no Open button.

`DesktopToolStep` is unchanged, so its mounted row still uses `toolStatusOf` and shows pending, cancelled, and unknown as running. Root can read `projectDesktopToolStatus` when it replaces that row. Do not edit `ToolStepRow`.

For leftover generic parts only, `planDesktopToolPresentation` returns `passthrough`, `card`, or `group`. A passthrough goes back to the existing presenter. Do not also render `DesktopToolStep` for a part rendered from the plan. `DesktopHistoricalStepGroup` is the status-honest group. It has no hosted coworker glyph.

`apps/ui/lib/desktop/tool-presentation.ts` still skips redaction when a restored part has `desktopPreview === true`. That file was not edited. The historical cards redact again. The generic restored preview remains a root follow-up.

## Regressions

Colocated and not executed:

- `presentation.test.ts` covers the six statuses, lost and restarted acknowledgements, identity mismatch, redaction, the 2,000-character cut, malformed and oversized payloads, and grouping.
- `historical-cards.test.tsx` renders the three cards and the group, asserts the original copy, and asserts that Open does not fetch. The board store mock throws if this package imports it.

## Checks

Not run. No acceptance.
