'use client'

import { Button } from '@/components/ui/button'
import { DESKTOP_PDF_TEXT_MAX_QUERY } from '@/lib/desktop/pdf-text'
import { ChevronDownIcon, ChevronUpIcon, SearchIcon } from '@/lib/icons'
import { useDesktopLocale } from './DesktopLocale'

type Props = {
    query: string
    onQuery: (value: string) => void
    count: string
    message: string
    onPrevious: () => void
    onNext: () => void
    canStep: boolean
}

/** Document Find. Match arrows are separate from page arrows and file arrows. */
export function DesktopFilePdfFind({ query, onQuery, count, message, onPrevious, onNext, canStep }: Props) {
    const { language } = useDesktopLocale()
    const copy = language.messages.pdf
    return <form role="search" aria-label={copy.find} data-testid="file-pdf-find" className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-xs" onSubmit={event => event.preventDefault()}>
        <label className="flex min-w-40 flex-1 items-center gap-1">
            <SearchIcon className="size-3.5 shrink-0" />
            <input aria-label={copy.query} value={query} maxLength={DESKTOP_PDF_TEXT_MAX_QUERY} className="w-full bg-transparent outline-none" onChange={event => onQuery(event.target.value.slice(0, DESKTOP_PDF_TEXT_MAX_QUERY))} onKeyDown={event => {
                event.stopPropagation()
                if (event.key !== 'Enter') return
                event.preventDefault()
                if (!canStep) return
                if (event.shiftKey) onPrevious()
                else onNext()
            }} />
        </label>
        <span aria-live="polite" data-testid="file-pdf-find-count" className="min-w-16 text-center tabular-nums">{count}</span>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={copy.previousMatch} disabled={!canStep} onClick={onPrevious}><ChevronUpIcon className="size-3.5" /></Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={copy.nextMatch} disabled={!canStep} onClick={onNext}><ChevronDownIcon className="size-3.5" /></Button>
        <p role="status" className="basis-full text-muted-foreground">{message}</p>
    </form>
}
