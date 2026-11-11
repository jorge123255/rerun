'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { desktopFindInPage, type DesktopFindResult } from '@/lib/desktop/find-in-page'
import { XIcon } from '@/lib/icons'

export function DesktopConversationFind({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const [query, setQuery] = useState('')
    const [result, setResult] = useState<DesktopFindResult | null>(null)
    const currentQuery = useRef('')
    const generation = useRef(0)

    const run = useCallback(async (action: 'start' | 'next' | 'previous', text: string) => {
        const request = ++generation.current
        if (action === 'start') setResult(null)
        const found = await desktopFindInPage(action, text)
        if (request === generation.current) setResult(found)
    }, [])

    useEffect(() => {
        if (!open) return
        const selected = window.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? ''
        if (selected && selected.length <= 200) {
            currentQuery.current = selected
            setQuery(selected)
        }
        if (currentQuery.current) void run('start', currentQuery.current)
        return () => {
            generation.current++
            void desktopFindInPage('stop')
        }
    }, [open, run])

    function close() {
        generation.current++
        setResult(null)
        onOpenChange(false)
    }

    if (!open) return null
    const status = result === null ? null : !result.ok ? 'Find is unavailable in this window.'
        : result.matches ? `${result.activeMatchOrdinal ?? 0} of ${result.matches}` : 'No matches'
    return <form className="mb-2 flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-background p-2" onSubmit={event => { event.preventDefault(); void run('next', query) }}>
        <Input autoFocus value={query} aria-label="Find in conversation" placeholder="Find in conversation" className="h-8 min-w-0 flex-1" maxLength={200}
            onChange={event => {
                const text = event.target.value
                currentQuery.current = text
                setQuery(text)
                void run('start', text)
            }}
            onKeyDown={event => {
                if (event.key === 'Escape') { event.preventDefault(); close() }
                if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); void run('previous', query) }
            }} />
        <span className="text-xs text-muted-foreground" role="status">{status}</span>
        <Button type="button" size="sm" variant="outline" onClick={() => void run('previous', query)}>Previous</Button>
        <Button type="submit" size="sm" variant="outline">Next</Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Close find" onClick={close}><XIcon className="size-4" /></Button>
    </form>
}
