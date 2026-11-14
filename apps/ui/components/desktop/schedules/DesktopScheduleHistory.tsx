'use client'

import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { desktopWorkspaceRoutineChatSchema, type DesktopWorkspaceRoutineChat } from '@rerun/contracts'
import { RunStatusBadge } from '@rerun/ui/monitoring'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import { PanelList, PanelScroller } from '@/components/ui/panel-list'
import { PanelRow } from '@/components/ui/panel-row'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { ScheduleRequestError, scheduleRequest } from '@/lib/desktop/schedules/client'
import { engineRunSchema } from '@/lib/engine/types'
import { CalendarClockIcon } from '@/lib/icons'
import { useDesktopLocale } from '../DesktopLocale'

const scheduleRuns = z.array(engineRunSchema.pick({ id: true, status: true, startedAt: true }))
const scheduleChat = desktopWorkspaceRoutineChatSchema.strip()

export function DesktopScheduleHistory({ agentId, slug, title, onBack, onOpenChat }: {
    agentId: string
    slug: string
    title: string
    onBack: () => void
    onOpenChat: (chat: DesktopWorkspaceRoutineChat) => void
}) {
    const { t, language } = useDesktopLocale()
    const locale = desktopLocaleTag(language.locale)
    const [runs, setRuns] = useState<z.infer<typeof scheduleRuns> | null>(null)
    const [loadError, setLoadError] = useState<string | true | null>(null)
    const [openError, setOpenError] = useState<string | true | null>(null)
    const [opening, setOpening] = useState<string | null>(null)
    const activeOpen = useRef<AbortController | null>(null)
    useEffect(() => {
        const controller = new AbortController()
        void scheduleRequest(agentId, 'GET', undefined, `?history=${encodeURIComponent(slug)}`, controller.signal)
            .then(data => { if (!controller.signal.aborted) setRuns(scheduleRuns.parse(data)) })
            .catch(error => {
                if (!controller.signal.aborted) setLoadError(error instanceof ScheduleRequestError ? error.message : true)
            })
        return () => {
            controller.abort()
            activeOpen.current?.abort()
        }
    }, [agentId, slug])

    async function openRun(runId: string) {
        if (activeOpen.current) return
        const controller = new AbortController()
        activeOpen.current = controller
        setOpening(runId)
        setOpenError(null)
        try {
            const chat = scheduleChat.parse(await scheduleRequest(agentId, 'POST', { action: 'open-run', slug, runId }, '', controller.signal))
            if (chat.agentId !== agentId || chat.runId !== runId) throw new Error('Routine result identity changed')
            if (!controller.signal.aborted) onOpenChat(chat)
        } catch (error) {
            if (!controller.signal.aborted) setOpenError(error instanceof ScheduleRequestError ? error.message : true)
        } finally {
            activeOpen.current = null
            if (!controller.signal.aborted) setOpening(null)
        }
    }

    return <PanelEditorShell>
        <PanelEditorHeader title={title} backLabel={t('routines.back')} onBack={onBack} />
        {loadError && <p role="alert" className="p-3 text-xs text-destructive">{loadError === true ? t('runHistory.unavailable') : loadError}</p>}
        {openError && <p role="alert" className="p-3 text-xs text-destructive">{openError === true ? t('routines.noResult') : openError}</p>}
        {runs === null && !loadError && <p role="status" className="p-3 text-xs text-muted-foreground">{t('runHistory.loading')}</p>}
        {runs?.length === 0 && <EmptyState icon={CalendarClockIcon} title={t('routines.noExecutions')} />}
        {runs && runs.length > 0 && <PanelScroller><PanelList>
            {runs.map(run => <PanelRow key={run.id}
                title={run.startedAt ? new Date(run.startedAt).toLocaleString(locale) : t('runHistory.notRecorded')}
                meta={<RunStatusBadge status={run.status} label={t(`routines.status.${run.status}`)} />}
                actions={<Button size="sm" variant="ghost" loading={opening === run.id} disabled={opening !== null}
                    onClick={() => void openRun(run.id)}>{t('routines.openResult')}</Button>}
            />)}
        </PanelList></PanelScroller>}
    </PanelEditorShell>
}
