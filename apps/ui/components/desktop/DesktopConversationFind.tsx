'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { desktopFindInPage } from '@/lib/desktop/find-in-page'
import { XIcon } from '@/lib/icons'

export function DesktopConversationFind({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const [query, setQuery] = useState('')
    const [result, setResult] = useState<{ matches: number; activeMatchOrdinal: number } | null>(null)
    const [unavailable, setUnavailable] = useState(false)
    useEffect(() => {
        if (!open) return
        const selected = window.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? ''
        if (selected && selected.length <= 200 && !selected.includes('\n')) setQuery(selected)
    }, [open])

    useEffect(() => () => { void desktopFindInPage('stop') }, [])

    async function run(action: 'start' | 'next' | 'previous', text = query) {
        const found = await desktopFindInPage(action, text)
        if (!found.ok) {
            setUnavailable(true)
            setResult(null)
            return
        }
        setUnavailable(false)
        setResult({ matches: found.matches ?? 0, activeMatchOrdinal: found.activeMatchOrdinal ?? 0 })
    }

    async function close() {
        await desktopFindInPage('stop')
        setResult(null)
        setUnavailable(false)
        onOpenChange(false)
    }

    if (!open) return null
    return <form className="mb-2 flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-background p-2" onSubmit={event => { event.preventDefault(); void run('next') }}>
        <Input autoFocus value={query} aria-label="Find in conversation" placeholder="Find in conversation" className="h-8 min-w-0 flex-1" maxLength={200}
            onChange={event => { const text = event.target.value; setQuery(text); void run('start', text) }}
            onKeyDown={event => {
                if (event.key === 'Escape') { event.preventDefault(); void close() }
                if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); void run('previous') }
            }} />
        <span className="text-xs text-muted-foreground" role="status">{unavailable ? 'Find is unavailable in this window.' : result ? (result.matches ? `${result.activeMatchOrdinal} of ${result.matches}` : 'No matches') : null}</span>
        <Button type="button" size="sm" variant="outline" onClick={() => void run('previous')}>Previous</Button>
        <Button type="submit" size="sm" variant="outline">Next</Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Close find" onClick={() => void close()}><XIcon className="size-4" /></Button>
    </form>
}
