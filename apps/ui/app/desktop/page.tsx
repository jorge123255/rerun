import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { DesktopApp } from '@/components/desktop/DesktopApp'
import { authenticateDesktopRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopRuntime } from '@/lib/desktop/server/runtime'
import { readDesktopBootstrap } from '@/lib/desktop/server/store'
import { desktopAgentView } from '@/lib/desktop/server/views'

export const dynamic = 'force-dynamic'

export default async function DesktopPage() {
    let bootstrap: Awaited<ReturnType<typeof readDesktopBootstrap>>
    try {
        const runtime = await readDesktopRuntime()
        await authenticateDesktopRequest(new Request(`${runtime.app.origin}/desktop`, { headers: await headers() }))
        bootstrap = await readDesktopBootstrap(await openDesktopDatabase(runtime.dataRoot))
    } catch (error) {
        if (error instanceof DesktopHttpError) notFound()
        throw error
    }
    return <DesktopApp initialData={{ ...bootstrap, agents: bootstrap.agents.map(desktopAgentView) }} />
}
