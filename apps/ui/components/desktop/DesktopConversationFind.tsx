'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { findTranscriptRanges, paintTranscriptFind } from '@/lib/desktop/transcript-find'
import { XIcon } from '@/lib/icons'
import { useDesktopLocale } from './DesktopLocale'

type Matches = { query: string; ranges: Range[]; index: number }

export function DesktopConversationFind({ open, onOpenChange, transcript }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    transcript: RefObject<HTMLDivElement | null>
}) {
    const { t } = useDesktopLocale()
    const { scrollRef, stopScroll } = useStickToBottomContext()
    const [query, setQuery] = useState('')
    const [matches, setMatches] = useState<Matches | null>(null)
    const lastScroll = useRef<{ query: string; index: number } | null>(null)
    const form = useRef<HTMLFormElement>(null)

    useEffect(() => {
        if (!open) return
        const selection = window.getSelection()
        if (!transcript.current?.contains(selection?.anchorNode ?? null) || !transcript.current?.contains(selection?.focusNode ?? null)) return
        const selected = selection?.toString().replace(/\s+/g, ' ').trim() ?? ''
        if (selected && selected.length <= 200) setQuery(selected)
    }, [open, transcript])

    useEffect(() => {
        const scope = transcript.current
        if (!open || !scope || !query.trim()) return
        let timer: ReturnType<typeof setTimeout> | undefined
        const update = () => {
            const ranges = findTranscriptRanges(scope, query)
            setMatches(previous => ({
                query, ranges, index: previous?.query === query ? Math.min(previous.index, Math.max(0, ranges.length - 1)) : 0,
            }))
        }
        update()
        const observer = new MutationObserver(() => {
            if (timer !== undefined) return
            timer = setTimeout(() => { timer = undefined; update() }, 40)
        })
        observer.observe(scope, {
            subtree: true, childList: true, characterData: true, attributes: true,
            attributeFilter: ['open', 'hidden', 'aria-hidden', 'inert', 'class', 'style', 'data-chat-find-url'],
        })
        return () => { clearTimeout(timer); observer.disconnect() }
    }, [open, query, transcript])

    const shown = open && matches?.query === query && query.trim() ? matches : null
    useEffect(() => {
        const range = shown?.ranges[shown.index]
        if (!range || !shown) { lastScroll.current = null; return }
        const clear = paintTranscriptFind(shown.ranges, range)
        const viewport = scrollRef.current
        const previous = lastScroll.current
        if (viewport && (previous?.query !== shown.query || previous.index !== shown.index)) {
            lastScroll.current = { query: shown.query, index: shown.index }
            const bounds = range.getBoundingClientRect?.()
            const view = viewport.getBoundingClientRect()
            if (bounds && (bounds.top < view.top + (form.current?.offsetHeight ?? 0) || bounds.bottom > view.bottom)) {
                stopScroll()
                viewport.scrollTop += bounds.top - view.top - viewport.clientHeight / 2
            }
        }
        return clear
    }, [shown, scrollRef, stopScroll])

    function move(direction: 1 | -1) {
        lastScroll.current = null
        setMatches(previous => previous?.query === query && previous.ranges.length > 0
            ? { ...previous, index: (previous.index + direction + previous.ranges.length) % previous.ranges.length }
            : previous)
    }

    function close() {
        setMatches(null)
        onOpenChange(false)
    }

    if (!open) return null
    const count = shown?.ranges.length ?? 0
    const label = t('conversationFind.field')
    const status = !shown ? null : count
        ? t('conversationFind.count', { current: shown.index + 1, total: count })
        : t('conversationFind.noMatches')
    return <form ref={form} role="search" aria-label={label} className="sticky top-0 z-20 mb-2 flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-background p-2"
        onSubmit={event => { event.preventDefault(); move(1) }}>
        <Input autoFocus value={query} aria-label={label} placeholder={label} className="h-8 min-w-0 flex-1" maxLength={200}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
                if (event.key === 'Escape') { event.preventDefault(); close() }
                if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); move(-1) }
            }} />
        <span className="text-xs text-muted-foreground" role="status">{status}</span>
        <Button type="button" size="sm" variant="outline" disabled={!count} onClick={() => move(-1)}>{t('conversationFind.previous')}</Button>
        <Button type="submit" size="sm" variant="outline" disabled={!count}>{t('conversationFind.next')}</Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label={t('conversationFind.close')} onClick={close}><XIcon className="size-4" /></Button>
    </form>
}
