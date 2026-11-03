'use client'

import { useId, useState } from 'react'
import { MessageCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { fullDateTime, messageDayLabel, messageTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { DesktopSessionView } from './DesktopApp'

export function groupDesktopChats(sessions: DesktopSessionView[], now = new Date()) {
    const groups: { day: string; sessions: DesktopSessionView[] }[] = []
    const ordered = [...sessions].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
    for (const session of ordered) {
        const day = Number.isFinite(Date.parse(session.createdAt)) ? messageDayLabel(session.createdAt, now) : 'Date unavailable'
        const last = groups.at(-1)
        if (last?.day === day) last.sessions.push(session)
        else groups.push({ day, sessions: [session] })
    }
    return groups
}

export function DesktopChatHistory({ sessions, selectedId, busy, onSelect }: {
    sessions: DesktopSessionView[]
    selectedId: string | null
    busy: boolean
    onSelect: (id: string) => void
}) {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const titleId = useId()
    const descriptionId = useId()
    const shown = sessions.filter(session => session.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))

    return (
        <Popover open={open} onOpenChange={value => { setOpen(value); if (!value) setQuery('') }}>
            <PopoverTrigger asChild>
                <Button type="button" size="sm" variant="outline" disabled={busy} aria-label={`Conversation history (${sessions.length})`}>
                    <MessageCircle aria-hidden className="size-3.5" /> Chats <span className="tabular-nums text-muted-foreground">{sessions.length}</span>
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" collisionPadding={12} aria-labelledby={titleId} aria-describedby={descriptionId}
                className="max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-1.5rem)] gap-2 overflow-hidden p-2">
                <div className="shrink-0 px-2 pt-1">
                    <h2 id={titleId} className="text-sm font-semibold">Saved conversations</h2>
                    <p id={descriptionId} className="mt-1 text-xs text-muted-foreground">Dates show when chats were created.</p>
                </div>
                {sessions.length > 0 && <Input className="shrink-0" type="search" aria-label="Search conversations" placeholder="Search conversations…" value={query} onChange={event => setQuery(event.target.value)} />}
                <div className="max-h-[min(420px,50dvh)] min-h-0 overflow-y-auto">
                    {groupDesktopChats(shown).map(({ day, sessions: entries }) => (
                        <div key={day} className="pb-1">
                            <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{day}</p>
                            {entries.map(session => (
                                <button key={session.id} type="button" disabled={busy} aria-current={selectedId === session.id ? 'true' : undefined}
                                    onClick={() => { onSelect(session.id); setOpen(false); setQuery('') }}
                                    className={cn('flex min-h-11 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-muted/40 disabled:opacity-50', selectedId === session.id && 'bg-muted/60')}>
                                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{session.title}</span>
                                    {Number.isFinite(Date.parse(session.createdAt)) && <time dateTime={session.createdAt} title={`Created ${fullDateTime(session.createdAt)}`}
                                        className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{messageTime(session.createdAt)}</time>}
                                </button>
                            ))}
                        </div>
                    ))}
                    {shown.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted-foreground">{sessions.length ? 'No matching conversations.' : 'No saved conversations yet. Start with New chat.'}</p>}
                </div>
            </PopoverContent>
        </Popover>
    )
}
