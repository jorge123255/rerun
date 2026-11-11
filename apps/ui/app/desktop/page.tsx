import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { DesktopApp } from '@/components/desktop/DesktopApp'
import { DesktopLocale } from '@/components/desktop/DesktopLocale'
import { readDesktopLanguage } from '@/lib/desktop/server/language'
import { authenticateDesktopRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { readDesktopRuntime } from '@/lib/desktop/server/runtime'
import { readDesktopWorkspace } from '@/lib/desktop/server/settings'

export const dynamic = 'force-dynamic'

export default async function DesktopPage() {
    try {
        const runtime = await readDesktopRuntime()
        const requestHeaders = await headers()
        await authenticateDesktopRequest(new Request(`${runtime.app.origin}/desktop`, { headers: requestHeaders }))
        const [bootstrap, language] = await Promise.all([
            readDesktopWorkspace(runtime),
            readDesktopLanguage(runtime, requestHeaders.get('accept-language')),
        ])
        return <DesktopLocale initial={language}><DesktopApp initialData={bootstrap} /></DesktopLocale>
    } catch (error) {
        if (error instanceof DesktopHttpError) notFound()
        throw error
    }
}
