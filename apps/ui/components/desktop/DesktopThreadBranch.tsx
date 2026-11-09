'use client'

import { Badge, Stripes } from '@rerun/ui/primitives'
import { ChevronRightIcon, CalendarClock, WebhookIcon } from '@/lib/icons'
import { threadOpener } from '@/lib/desktop/general-threads'
import type { DesktopSessionView } from './DesktopApp'
import { shortRelativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'

const THREAD_STRIPES_INK = 'color-mix(in oklab, var(--foreground) 6%, transparent)'

type ThreadCard = DesktopSessionView & { source?: string | null; automationName?: string | null }

export function DesktopThreadBranch({ thread, onOpen }: { thread: ThreadCard; onOpen: () => void }) {
    const opener = threadOpener(thread, null)
    const automated = thread.source === 'schedule' || thread.source === 'trigger'
    const SourceIcon = thread.source === 'trigger' ? WebhookIcon : CalendarClock
    const when = Number.isFinite(Date.parse(thread.createdAt)) ? shortRelativeTime(thread.createdAt) : ''
    return (
        <div className="flex w-full flex-col gap-2" data-thread-row={thread.id} data-testid="desktop-thread-branch">
            <div className={cn('w-fit max-w-full rounded-2xl rounded-bl-md bg-muted px-3 py-1.5 text-xs text-foreground/80', opener.generic && 'text-muted-foreground italic')}>
                <span className="line-clamp-2 pr-0.5 break-words">{opener.text}</span>
            </div>
            <div className="relative w-full pl-7">
                <span aria-hidden className="absolute -top-2 left-3.5 h-6 w-3 rounded-bl-md border-b border-l border-border" />
                <button type="button" onClick={onOpen} className="group relative flex h-8 max-w-full items-center gap-2 overflow-hidden rounded-lg border border-border px-2.5 text-left text-sm transition-colors hover:border-foreground/20 [&>:not(:first-child)]:relative">
                    <Stripes fade="right" color={THREAD_STRIPES_INK} band={4} period={8} className="rotate-180 opacity-60 transition-opacity group-hover:opacity-100" />
                    {automated && <SourceIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 truncate font-medium">{thread.title}</span>
                    <Badge size="xs" tone="neutral" glow={false} className="shrink-0">Thread</Badge>
                    {when && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{when}</span>}
                    <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </button>
            </div>
        </div>
    )
}
