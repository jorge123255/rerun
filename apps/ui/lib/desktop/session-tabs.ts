import { z } from 'zod'
import { MAX_REMEMBERED_TABS, type SessionTabsState } from '@/lib/chat/session-tabs'

export type DesktopTabLayout = SessionTabsState & { revision: number }

const tab = z.object({ uid: z.string().min(1).max(128), id: z.string().min(1).max(128).nullable() })
export const desktopTabWriteSchema = z.object({
    baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
    tabs: z.array(tab).min(1).max(MAX_REMEMBERED_TABS),
    activeIndex: z.number().int().min(0),
}).strict().refine(({ tabs, activeIndex }) => activeIndex < tabs.length
    && new Set(tabs.map(t => t.uid)).size === tabs.length
    && new Set(tabs.map(t => t.id)).size === tabs.length)
export type DesktopTabWrite = z.infer<typeof desktopTabWriteSchema>
