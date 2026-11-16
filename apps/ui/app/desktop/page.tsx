import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { DesktopApp } from '@/components/desktop/DesktopApp'
import { DesktopLocale } from '@/components/desktop/DesktopLocale'
import { DesktopMacTitleBar } from '@/components/desktop/DesktopMacTitleBar'
import { readDesktopLanguage } from '@/lib/desktop/server/language'
import { authenticateDesktopRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { readDesktopRuntime } from '@/lib/desktop/server/runtime'
import { readDesktopWorkspace } from '@/lib/desktop/server/settings'
import { DesktopSpeechPrime } from '@/components/desktop/speech/DesktopSpeechPrime'
import { desktopAuxiliaryStore } from '@/lib/desktop/server/auxiliary/store'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopSpeechSettings } from '@/lib/desktop/server/speech'
import { listDesktopUsageWaitKeys } from '@/lib/desktop/server/usage-waits'

export const dynamic = 'force-dynamic'

async function readPageData() {
    try {
        const runtime = await readDesktopRuntime()
        const requestHeaders = await headers()
        await authenticateDesktopRequest(new Request(`${runtime.app.origin}/desktop`, { headers: requestHeaders }))
        return await Promise.all([
            readDesktopWorkspace(runtime),
            readDesktopLanguage(runtime, requestHeaders.get('accept-language')),
            /(?:^| )RerunLocalDesktopMac\/1$/.test(requestHeaders.get('user-agent') ?? ''),
            // Whether replies can be read aloud, the voice and the automatic switch. Never the key.
            openDesktopDatabase(runtime.dataRoot).then(db => readDesktopSpeechSettings(db, desktopAuxiliaryStore(db))).catch(() => null),
            // Messages kept from before a restart, waiting for their plan to reset.
            listDesktopUsageWaitKeys(runtime).catch(() => []),
        ])
    } catch (error) {
        if (error instanceof DesktopHttpError) notFound()
        throw error
    }
}

export default async function DesktopPage() {
    const [bootstrap, language, mac, speech, usageWaits] = await readPageData()
    return <>{mac && <DesktopMacTitleBar />}<DesktopSpeechPrime settings={speech} /><DesktopLocale initial={language}><DesktopApp initialData={bootstrap} usageWaits={usageWaits} /></DesktopLocale></>
}
