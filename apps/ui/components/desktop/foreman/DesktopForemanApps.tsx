'use client'

import { useEffect, useState } from 'react'
import { foremanChatRefSchema, type DesktopForemanChatRef } from '@rerun/contracts'
import { z } from 'zod'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { PanelList } from '@/components/ui/panel-list'
import { PanelRow } from '@/components/ui/panel-row'
import { BlocksIcon } from '@/lib/icons'
import { DESKTOP_CONNECTOR_APPS_CHANGED } from '@/lib/desktop/use-connector-apps'
import { useDesktopLocale } from '../DesktopLocale'

const sharedApp = z.object({ id: z.string().uuid(), name: z.string(), label: z.string().nullable() })
const listing = z.object({ chat: foremanChatRefSchema, apps: z.array(sharedApp) })

export function DesktopForemanApps({ chat, onClose }: { chat: DesktopForemanChatRef; onClose: () => void }) {
    const { t } = useDesktopLocale()
    const [apps, setApps] = useState<z.infer<typeof sharedApp>[] | null>(null)
    const [error, setError] = useState(false)
    const [retry, setRetry] = useState(0)
    const { workspaceId, chatId } = chat
    useEffect(() => {
        let pending: AbortController | undefined
        const read = async () => {
            pending?.abort()
            const controller = new AbortController()
            pending = controller
            setApps(null)
            setError(false)
            try {
                const query = new URLSearchParams({ workspaceId, chatId })
                const response = await fetch(`/api/desktop/foreman/apps?${query}`, { cache: 'no-store', signal: controller.signal })
                if (!response.ok) throw Error()
                const result = listing.parse(await response.json())
                if (result.chat.workspaceId !== workspaceId || result.chat.chatId !== chatId) throw Error()
                if (!controller.signal.aborted) setApps(result.apps)
            } catch {
                if (!controller.signal.aborted) setError(true)
            }
        }
        void read()
        window.addEventListener(DESKTOP_CONNECTOR_APPS_CHANGED, read)
        window.addEventListener('focus', read)
        return () => {
            pending?.abort()
            window.removeEventListener(DESKTOP_CONNECTOR_APPS_CHANGED, read)
            window.removeEventListener('focus', read)
        }
    }, [workspaceId, chatId, retry])
    return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
        <DialogContent>
            <DialogHeaderBar icon={BlocksIcon} title={t('coworker.destinations.services')} description={t('foreman.appsDescription')} />
            <section aria-label={t('foreman.sharedApps')} className="max-h-[65vh] overflow-y-auto">
                {error ? <div className="space-y-2"><p role="alert">{t('foreman.appsUnavailable')}</p>
                    <Button variant="outline" size="sm" onClick={() => setRetry(n => n + 1)}>{t('coworkerSetup.retry')}</Button></div>
                : apps === null ? <p role="status" className="text-sm text-muted-foreground">{t('coworkerSetup.loading')}</p>
                : apps.length ? <PanelList>{apps.map(app => <PanelRow key={app.id} title={app.label || app.name} description={app.label ? app.name : undefined} />)}</PanelList>
                : <p className="text-sm text-muted-foreground">{t('foreman.appsEmpty')}</p>}
            </section>
        </DialogContent>
    </Dialog>
}
