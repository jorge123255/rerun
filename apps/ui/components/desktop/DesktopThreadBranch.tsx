'use client'

import { useDesktopLocale } from './DesktopLocale'
import { Badge, Stripes } from '@rerun/ui/primitives'
import { ChevronRightIcon, CalendarClock, WebhookIcon } from '@/lib/icons'
import { threadOpener } from '@/lib/desktop/general-threads'
import type { DesktopSessionView } from './DesktopApp'
import { StateDot } from '@/components/agent/sheet/OpenChatsTabStrip'
import { shortRelativeTime } from '@rerun/i18n/format'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { cn } from '@/lib/utils'

const THREAD_STRIPES_INK = 'color-mix(in oklab, var(--foreground) 6%, transparent)'

const BRANCH_TONE = {
    live: 'border-brand/70',
    needs: 'border-orange-400/70',
    error: 'border-red-400/70',
    done: 'border-border',
}

export function DesktopThreadBranch({ thread, needsYou, onOpen }: { thread: DesktopSessionView; needsYou?: boolean; onOpen: () => void }) {
    const { language, t } = useDesktopLocale()
    const opener = threadOpener(thread, thread.originAgentName ?? null, t)
    const state = thread.runStatus === 'running' ? 'live' : thread.runStatus === 'error' ? 'error' : needsYou ? 'needs' : 'done'
    const automated = thread.source === 'schedule' || thread.source === 'trigger'
    const SourceIcon = thread.source === 'trigger' ? WebhookIcon : CalendarClock
    const when = Number.isFinite(Date.parse(thread.createdAt)) ? shortRelativeTime(thread.createdAt, desktopLocaleTag(language.locale)) : ''
    return (
        <div className="flex w-full flex-col gap-2" data-thread-row={thread.id} data-testid="desktop-thread-branch">
            <div className={cn('w-fit max-w-full rounded-2xl rounded-bl-md bg-muted px-3 py-1.5 text-xs text-foreground/80', opener.generic && 'text-muted-foreground italic')}>
                <span className="line-clamp-2 pr-0.5 break-words">{opener.text}</span>
            </div>
            <div className="relative w-full pl-7">
                <span aria-hidden className={cn("absolute -top-2 left-3.5 h-6 w-3 rounded-bl-md border-b border-l transition-colors", BRANCH_TONE[state])} />
                <button type="button" onClick={onOpen} title={thread.automationName && thread.automationName !== thread.title ? thread.automationName : undefined} className="group relative flex h-8 max-w-full items-center gap-2 overflow-hidden rounded-lg border border-border px-2.5 text-left text-sm transition-colors hover:border-foreground/20 [&>:not(:first-child)]:relative">
                    <Stripes fade="right" color={THREAD_STRIPES_INK} band={4} period={8} className="rotate-180 opacity-60 transition-opacity group-hover:opacity-100" />
                    {state === 'live' && <span role="img" aria-label={t('running')}><StateDot state="live" /></span>}
                    {automated && <SourceIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className={cn('min-w-0 truncate font-medium',
                        automated && (state === 'error' ? 'text-destructive' : thread.automationOutcome === 'nothing' && 'text-muted-foreground'))}>{thread.title}</span>
                    {(state === 'needs' || state === 'error') && <Badge size="xs" tone={state === 'needs' ? 'orange' : 'red'} glow={false} className="shrink-0">{t(state)}</Badge>}
                    {when && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{when}</span>}
                    <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </button>
            </div>
        </div>
    )
}
