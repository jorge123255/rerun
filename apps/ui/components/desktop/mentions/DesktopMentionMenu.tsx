'use client'

import { AgentBuddy } from '@rerun/ui/iso-grid'
import { useEffect, useRef } from 'react'
import type { MentionSkill } from '@/components/chat/MentionAutocomplete'
import { cn } from '@/lib/utils'
import type { DesktopCoworkerCallTarget } from '../../../../../packages/contracts/src/desktop-coworker-calls.ts'

export type DesktopMentionItem = {
    kind: 'agent'
    target: DesktopCoworkerCallTarget
    id: string
    name: string
    handle: string | null
    hint: string
    preferred: boolean
} | ({ kind: 'skill' } & MentionSkill)

export function DesktopMentionMenu({ trigger, items, highlight, onHover, onPick }: {
    trigger: '@' | '/'
    items: DesktopMentionItem[]
    highlight: number
    onHover: (index: number) => void
    onPick: (item: DesktopMentionItem) => void
}) {
    const listRef = useRef<HTMLUListElement>(null)
    useEffect(() => {
        const list = listRef.current
        const row = list?.children[highlight] as HTMLElement | undefined
        if (!list || !row) return
        if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop
        else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight
    }, [highlight])

    return <div className="absolute bottom-full left-0 right-0 z-50 mb-1 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
        <p className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{trigger === '@' ? 'Coworkers' : 'Skills'}</p>
        <ul ref={listRef} role="listbox" className="relative max-h-56 space-y-0.5 overflow-y-auto p-1">
            {items.map((item, index) => <li key={item.kind === 'agent' ? item.id : item.slug}>
                <button
                    type="button"
                    role="option"
                    aria-selected={index === highlight}
                    className={cn('flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm', index === highlight && 'bg-accent text-accent-foreground')}
                    onMouseEnter={() => onHover(index)}
                    onMouseDown={event => {
                        event.preventDefault()
                        onPick(item)
                    }}
                >
                    {item.kind === 'agent' && <AgentBuddy agentId={item.id} size={20} animated={false} facing="right" />}
                    <span className="flex-1 min-w-0">
                        <span className="block truncate">{item.name}{item.kind === 'skill' && <span className="ml-1.5 text-muted-foreground">/{item.slug}</span>}</span>
                        {item.kind === 'agent' && item.handle && <span className="block truncate text-xs text-muted-foreground">@{item.handle}</span>}
                        {item.kind === 'skill' && item.description && <span className="block truncate text-xs text-muted-foreground">{item.description}</span>}
                    </span>
                    {item.kind === 'agent' && item.hint && <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">{item.hint}</span>}
                </button>
            </li>)}
        </ul>
    </div>
}
