import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { DesktopApp } from '@/components/desktop/DesktopApp'
import { authenticateDesktopRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { readDesktopRuntime } from '@/lib/desktop/server/runtime'
import { readDesktopWorkspace } from '@/lib/desktop/server/settings'

export const dynamic = 'force-dynamic'

export default async function DesktopPage() {
    let bootstrap: Awaited<ReturnType<typeof readDesktopWorkspace>>
    try {
        const runtime = await readDesktopRuntime()
        await authenticateDesktopRequest(new Request(`${runtime.app.origin}/desktop`, { headers: await headers() }))
        bootstrap = await readDesktopWorkspace(runtime)
    } catch (error) {
        if (error instanceof DesktopHttpError) notFound()
        throw error
    }
    return <DesktopApp initialData={bootstrap} />
}
