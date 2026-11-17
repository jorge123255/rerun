import { desktopSocketSchema, takeoverResultSchema, type DesktopSocketView, type DesktopViewMode, type TakeoverResult } from '@rerun/contracts'

import { api } from '@/api/client'

type Caller = { accessToken: string; workspaceId: number }

const desktopOf = (agentId: string) => `/api/v1/agents/${encodeURIComponent(agentId)}/desktop`

// A fresh socket each time: its ticket is spent within a minute.
export async function openDesktop(caller: Caller, agentId: string, mode: DesktopViewMode): Promise<DesktopSocketView> {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return desktopSocketSchema.parse(await api(desktopOf(agentId), { ...caller, method: 'POST', body: { mode, timeZone } }))
}

export async function startTakeover(caller: Caller, agentId: string, url?: string): Promise<void> {
    await api(`${desktopOf(agentId)}/takeover`, { ...caller, method: 'POST', body: url ? { url } : {} })
}

// keepOpen when the person hands the browser back to the run that asked for it: the window stays on
// the coworker's screen. Skipped, it closes.
export async function finishTakeover(caller: Caller, agentId: string, { keepOpen = false } = {}): Promise<TakeoverResult> {
    return takeoverResultSchema.parse(await api(`${desktopOf(agentId)}/takeover${keepOpen ? '?keepOpen=1' : ''}`, { ...caller, method: 'DELETE' }))
}
