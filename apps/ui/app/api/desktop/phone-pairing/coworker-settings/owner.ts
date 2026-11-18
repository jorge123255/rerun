import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { phoneSettingsAgentId } from '@/lib/desktop/server/phone-coworker-settings'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { findDesktopAgent } from '@/lib/desktop/server/store'

export async function phoneSettingsOwner(runtime: DesktopRuntime, request: Request) {
    const query = new URL(request.url).searchParams
    const id = phoneSettingsAgentId.safeParse(query.get('agentId'))
    if (!id.success || query.size !== 1) throw new DesktopHttpError(404, 'Not found')
    // Each authenticated workspace owns a separate database, whose one local roster is id 1.
    const owner = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), id.data)
    if (!owner || owner.workspaceId !== 1) throw new DesktopHttpError(404, 'Not found')
    return owner
}
