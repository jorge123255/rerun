'use client'

import { useMemo } from 'react'
import { OpenChatsTabStrip, type OpenChatsTabsProps, type TabState } from './OpenChatsTabStrip'

import type { SessionTab } from '@/hooks/useSessionTabs'
import { ATTENTION_STATUSES } from '@/lib/board/attention'
import { useBoardStore } from '@/stores/board.store'

/**
 * The coworker's open conversations, left-aligned under the pills: the active one on a muted fill,
 * the others as plain text. Too many to fit, the row scrolls and only the edge still hiding a tab
 * fades.
 */
export function OpenChatsTabs({ tabs, activeIndex, onSelect, onClose, onCreate }: OpenChatsTabsProps) {
    const sessions = useBoardStore(s => s.sessions)
    const statusById = useMemo(() => new Map(sessions.map(session => [session.id, session.status])), [sessions])

    const stateOf = (tab: SessionTab): TabState => {
        const status = tab.id ? statusById.get(tab.id) : undefined
        if (status === 'working') return 'live'
        if (status && ATTENTION_STATUSES.has(status)) return 'needs'
        return 'quiet'
    }

    return <OpenChatsTabStrip tabs={tabs} activeIndex={activeIndex} onSelect={onSelect} onClose={onClose} onCreate={onCreate} stateOf={stateOf} />
}
