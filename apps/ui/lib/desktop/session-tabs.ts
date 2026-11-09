import { z } from 'zod'
import { MAX_REMEMBERED_TABS, type SessionTabsState } from '@/lib/chat/session-tabs'
import { isGeneralTab } from '@/lib/desktop/general-threads'

export type DesktopTabLayout = SessionTabsState & { revision: number }

const tab = z.object({ uid: z.string().min(1).max(128), id: z.string().min(1).max(128).nullable() })

function tabsIdentifyChats(tabs: { uid: string; id: string | null }[]) {
    const generals = tabs.filter(item => isGeneralTab(item))
    const blanks = tabs.filter(item => item.id === null && !isGeneralTab(item))
    const ids = tabs.flatMap(item => item.id === null ? [] : [item.id])
    return generals.length <= 1 && blanks.length <= 1 && new Set(ids).size === ids.length && new Set(tabs.map(item => item.uid)).size === tabs.length
}

export const desktopTabWriteSchema = z.object({
    baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
    tabs: z.array(tab).min(1).max(MAX_REMEMBERED_TABS + 1),
    activeIndex: z.number().int().min(0),
}).strict().refine(({ tabs, activeIndex }) => activeIndex < tabs.length && tabsIdentifyChats(tabs)
    && tabs.filter(item => !isGeneralTab(item)).length <= MAX_REMEMBERED_TABS)
export type DesktopTabWrite = z.infer<typeof desktopTabWriteSchema>
