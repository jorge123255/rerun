import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { DesktopApp } from '@/components/desktop/DesktopApp'
import { DesktopLocale } from '@/components/desktop/DesktopLocale'
import { readDesktopLanguage } from '@/lib/desktop/server/language'
import { authenticateDesktopRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { readDesktopRuntime } from '@/lib/desktop/server/runtime'
import { readDesktopWorkspace } from '@/lib/desktop/server/settings'

export const dynamic = 'force-dynamic'

async function readPageData() {
    try {
        const runtime = await readDesktopRuntime()
        const requestHeaders = await headers()
        await authenticateDesktopRequest(new Request(`${runtime.app.origin}/desktop`, { headers: requestHeaders }))
        return await Promise.all([
            readDesktopWorkspace(runtime),
            readDesktopLanguage(runtime, requestHeaders.get('accept-language')),
        ])
    } catch (error) {
        if (error instanceof DesktopHttpError) notFound()
        throw error
    }
}

export default async function DesktopPage() {
    const [bootstrap, language] = await readPageData()
    return <DesktopLocale initial={language}><DesktopApp initialData={bootstrap} /></DesktopLocale>
}
