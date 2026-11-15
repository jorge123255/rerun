import { z } from 'zod'
import { DESKTOP_PRESET_CONNECTION_ID, DESKTOP_PRESET_LABELS, DESKTOP_PRESET_TIERS, resolveDesktopPreset } from '@rerun/contracts'
import { desktopConnectionModelLabel } from '@/lib/desktop/chat-model'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopProviders, readDesktopWorkspacePreset, saveDesktopWorkspacePreset } from '@/lib/desktop/server/settings'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store' }
const change = z.object({ tier: z.enum(DESKTOP_PRESET_TIERS).nullable() }).strict()

// The workspace default as a Rerun preset: which one is chosen, and what each would run on now.
async function view(runtime: DesktopRuntime) {
    const [{ connections }, tier] = await Promise.all([readDesktopProviders(runtime), readDesktopWorkspacePreset(runtime)])
    return {
        tier,
        presets: DESKTOP_PRESET_TIERS.map(id => {
            const found = resolveDesktopPreset(id, connections)
            const connection = found && connections.find(item => item.id === found.connectionId)
            return { id, connectionId: DESKTOP_PRESET_CONNECTION_ID, label: DESKTOP_PRESET_LABELS[id], runsOn: found && connection ? `${connection.name} · ${desktopConnectionModelLabel(connection, found.model)}` : null }
        }),
    }
}

export function GET(request: Request) {
    return desktopRoute(request, async runtime => Response.json(await view(runtime), { headers }))
}

export function PUT(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = change.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose Fast, Balanced, Smart, or no preset.')
        await saveDesktopWorkspacePreset(runtime, parsed.data.tier)
        return Response.json(await view(runtime), { headers })
    })
}
