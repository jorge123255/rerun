/** Injected persistence projection for restart restore. */

import type { DesktopForemanChatRef } from './identity'
import type { DesktopPlanDecisionStatus } from './decision'
import type { DesktopForemanBuildProgressView } from './build-progress'
import type { DesktopDiscoveriesState } from './discovery-view'
import type { ForemanTab } from '@rerun/ui/foreman'
import type { DesktopCoworkerMention, DesktopCoworkerMentionFields, DesktopDocumentSendSelection, DesktopForemanModelRef } from '@rerun/contracts'
import { reconcileDesktopCoworkerMentions } from '@/components/desktop/mentions/coworker-mention-model'

export type DesktopForemanUiTab = ForemanTab

export type DesktopForemanPersistedUi = {
    workspaceId: string
    chatId: string
    open: boolean
    tab: DesktopForemanUiTab
    draft: string
    draftCoworkerMentions?: DesktopCoworkerMention[]
    pendingPlanRevisionId: string | null
    decision: DesktopPlanDecisionStatus
    build: DesktopForemanBuildProgressView | null
    discoveries: DesktopDiscoveriesState | null
    pendingSend?: DesktopCoworkerMentionFields & { requestId: string; text: string; modelChoice: DesktopForemanModelRef | null; documents?: DesktopDocumentSendSelection }
    dock?: import('@/lib/desktop/foreman-dock/layout').DockExtras
    placement: DesktopForemanPlacement
}

export type DesktopForemanPlacement =
    | { mode: 'dock'; side: 'left' | 'right'; width: number; height: number; dockWidth: number }
    | { mode: 'float'; corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'; width: number; height: number; dockWidth: number }

export const DEFAULT_DESKTOP_FOREMAN_PLACEMENT: DesktopForemanPlacement = {
    mode: 'dock',
    side: 'right',
    width: 420,
    height: 640,
    dockWidth: 420,
}

export type DesktopForemanPersistence = {
    load(identity: DesktopForemanChatRef): Promise<DesktopForemanPersistedUi | null>
    save(snapshot: DesktopForemanPersistedUi): Promise<void>
}

export function projectRestoredForemanUi(
    identity: DesktopForemanChatRef,
    saved: DesktopForemanPersistedUi | null,
): DesktopForemanPersistedUi | null {
    if (!saved) return null
    if (saved.workspaceId !== identity.workspaceId || saved.chatId !== identity.chatId) return null
    return saved
}

export function projectTabChange(current: DesktopForemanPersistedUi, tab: DesktopForemanUiTab): DesktopForemanPersistedUi {
    if (current.tab === tab) return current
    return { ...current, tab }
}

export function projectDraftChange(current: DesktopForemanPersistedUi, draft: string, selected?: DesktopCoworkerMention[]): DesktopForemanPersistedUi {
    if (current.draft === draft && selected === undefined) return current
    const mentions = selected ?? reconcileDesktopCoworkerMentions(current.draft, draft, current.draftCoworkerMentions ?? [])
    return { ...current, draft, draftCoworkerMentions: mentions.length ? mentions : undefined }
}

export function projectOpenChange(current: DesktopForemanPersistedUi, open: boolean): DesktopForemanPersistedUi {
    if (current.open === open) return current
    return { ...current, open }
}
