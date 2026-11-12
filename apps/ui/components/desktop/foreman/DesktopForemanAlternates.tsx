'use client'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { ArrowLeftIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useDesktopLocale } from '../DesktopLocale'
import { DesktopForemanHistoryMessage } from './transcript/DesktopForemanHistoryMessage'
import type { useDesktopForemanAlternates } from './useDesktopForemanAlternates'

type AlternateUi = ReturnType<typeof useDesktopForemanAlternates>

export function DesktopForemanAlternateReview({ ui }: { ui: AlternateUi }) {
    const { t } = useDesktopLocale()
    return <ConfirmDialog open={!!ui.review} onOpenChange={open => { if (!open && !ui.busy) ui.cancelReview() }}
        title={t('foreman.alternates.regenerate')} description={<>
            {t('foreman.alternates.confirm')}
            {ui.error && <span role="alert" className="mt-2 block text-destructive">{ui.error}</span>}
        </>}
        confirmLabel={t('foreman.alternates.regenerate')} cancelLabel={t('foreman.alternates.cancel')}
        confirmVariant="default" pending={ui.busy} onConfirm={event => { event.preventDefault(); void ui.confirm() }} />
}

export function DesktopForemanAlternates({ ui, sourceText }: { ui: AlternateUi; sourceText: (messageId: string) => string | undefined }) {
    const { t } = useDesktopLocale()
    const selected = ui.selected
    const view = ui.view
    return <section aria-label={t('foreman.alternates.title')} className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b p-2">
            <Button type="button" size="sm" variant="ghost" onClick={ui.close}><ArrowLeftIcon />{t('foreman.alternates.original')}</Button>
            {selected && <Button type="button" size="sm" variant="ghost" onClick={() => ui.select(null)}>{t('foreman.alternates.title')}</Button>}
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {ui.error && <p role="alert" className="text-xs text-destructive">{ui.error}</p>}
            {!selected && <ul className="space-y-2">
                {ui.items.map((item, index) => <li key={item.requestId}>
                    <Button type="button" variant="outline" className="h-auto w-full justify-start gap-2 overflow-hidden py-2 text-left" onClick={() => ui.select(item.requestId)}>
                        <span className="shrink-0">{t('foreman.alternates.entry', { number: ui.items.length - index })}</span>
                        {sourceText(item.messageId) && <span className="min-w-0 truncate text-muted-foreground">{sourceText(item.messageId)}</span>}
                    </Button>
                </li>)}
            </ul>}
            {selected && !view && !ui.error && <p role="status" className="text-xs text-muted-foreground">{t('foreman.alternates.loading')}</p>}
            {selected && !view && ui.error && <Button type="button" size="sm" variant="outline" onClick={ui.reload}>{t('foreman.retry')}</Button>}
            {view?.messages.map(message => <div key={message.id}
                className={cn('max-w-[95%] rounded-lg px-4 py-3 text-sm', message.role === 'user' ? 'ml-auto bg-secondary' : 'bg-transparent')}>
                <DesktopForemanHistoryMessage history={[{ kind: 'text', key: message.id, text: message.text }]} userLinks={message.role === 'user'} />
            </div>)}
            {view && view.status !== 'done' && <p role="status" className="text-xs text-muted-foreground">{t(`foreman.alternates.status.${view.status}`)}</p>}
        </div>
        {view && (view.status === 'running' || view.status === 'prepared' || view.status === 'uncertain') && <div className="flex justify-end gap-2 border-t p-2">
            {view.status === 'uncertain' && <Button type="button" size="sm" disabled={ui.busy} onClick={() => void ui.command('recover')}>{t('foreman.alternates.check')}</Button>}
            {view.status === 'prepared' && <Button type="button" size="sm" disabled={ui.busy} onClick={() => void ui.command('start')}>{t('foreman.alternates.regenerate')}</Button>}
            {view.status !== 'uncertain' && <Button type="button" size="sm" variant="secondary" disabled={ui.busy} onClick={() => void ui.command('stop')}>{t('foreman.stop')}</Button>}
        </div>}
    </section>
}
