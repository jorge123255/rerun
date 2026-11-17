'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { DESKTOP_ACTIVITY_OUTCOMES, DESKTOP_ACTIVITY_OUTCOME_WORDS, DESKTOP_ACTIVITY_SOURCES, DESKTOP_ACTIVITY_SOURCE_WORDS, type DesktopActivityOutcome } from '@rerun/contracts'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { PanelDialogContent } from '@/components/dialogs/PanelDialogContent'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollTextIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { DESKTOP_ARRIVE_TOP_CLASS } from '../panel-motion/DesktopArrive'
import { EMPTY_ACTIVITY_FILTERS, desktopActivityQuery, desktopActivityViewSchema, downloadDesktopActivityCsv, type DesktopActivityRow, type DesktopActivityView, type DesktopActivityViewFilters } from '@/lib/desktop/activity'

// The owner's one place to see what coworkers did and which rule allowed it. The rows come from
// the engine's trail on this Mac; nothing here is rebuilt from chat text.

const TONE: Record<DesktopActivityOutcome, string> = {
    'allowed-by-permission': 'bg-muted text-muted-foreground',
    'allowed-once-by-person': 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    started: 'bg-muted text-muted-foreground',
    cancelled: 'bg-muted text-muted-foreground',
    completed: 'bg-muted text-muted-foreground',
    'asked-person': 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    'declined-by-person': 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
    'refused-no-permission': 'bg-red-500/15 text-red-700 dark:text-red-300',
    'refused-policy': 'bg-red-500/15 text-red-700 dark:text-red-300',
    failed: 'bg-red-500/15 text-red-700 dark:text-red-300',
}

const selectClass = 'h-8 min-w-0 rounded-md border bg-background px-2 text-sm'
/** While the view is open and the window is shown, the trail is read again this often. */
export const ACTIVITY_REFRESH_MS = 5_000
// Closer to the top than this, the person is reading the newest rows: new ones may come in above them.
const AT_TOP_PX = 8

function when(value: string): string {
    const date = new Date(value)
    return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : value
}

function origin(row: DesktopActivityRow): string {
    const words = DESKTOP_ACTIVITY_SOURCE_WORDS[row.source]
    return row.sourceSlug ? `${words}: ${row.sourceSlug}` : words
}

export function DesktopActivityDialog({ onClose, onOpenConversation }: { onClose: () => void; onOpenConversation?: (target: { agentId: string; sessionId: string }) => Promise<void> }) {
    return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
        <PanelDialogContent closeLabel="Close activity" className="sm:h-[min(48rem,90dvh)] sm:max-w-4xl"
            onCloseAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLElement>('[aria-label^="Workspace menu,"]')?.focus({ preventScroll: true }) }}>
            <DialogHeaderBar icon={ScrollTextIcon} title="Activity" description="Every action your coworkers took, how it ended and which rule decided it. Kept on this Mac only." />
            <DesktopActivityPanel onOpenConversation={onOpenConversation && (async target => { await onOpenConversation(target); onClose() })} />
        </PanelDialogContent>
    </Dialog>
}

export function DesktopActivityPanel({ onOpenConversation }: { onOpenConversation?: (target: { agentId: string; sessionId: string }) => Promise<void> }) {
    const [filters, setFilters] = useState<DesktopActivityViewFilters>(EMPTY_ACTIVITY_FILTERS)
    const [view, setView] = useState<DesktopActivityView | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [more, setMore] = useState(false)
    const [busy, setBusy] = useState<'export' | 'clear' | null>(null)
    // What the open confirmation would clear: everything (`''`), one coworker, or the deleted ones.
    const [confirming, setConfirming] = useState<{ coworker: string; name: string } | null>(null)
    const generation = useRef(0)
    const scroller = useRef<HTMLDivElement>(null)
    // Rows that arrived while the person was reading further down: counted on the pill, not yet in the list.
    const [held, setHeld] = useState<DesktopActivityRow[]>([])
    // Rows that came in while the view was open: they slide in once.
    const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set())
    const latest = useRef({ view, held, filters })
    latest.current = { view, held, filters }
    const refreshing = useRef(false)
    // The filters the rows on screen were read with: the quiet read waits while a new filter is still loading.
    const shownFilters = useRef<DesktopActivityViewFilters | null>(null)

    const load = useCallback(async (next: DesktopActivityViewFilters, signal?: AbortSignal) => {
        const turn = ++generation.current
        setHeld([]); setFresh(new Set())
        setLoading(true)
        try {
            const response = await fetch(`/api/desktop/activity?${desktopActivityQuery(next)}`, { cache: 'no-store', signal })
            if (!response.ok) throw new Error('Could not read the activity. Try again.')
            const parsed = desktopActivityViewSchema.parse(await response.json())
            if (turn !== generation.current) return
            shownFilters.current = next
            setView(parsed); setError(null)
        } catch (failure) {
            if (turn !== generation.current || signal?.aborted) return
            setError(failure instanceof Error && failure.message ? failure.message : 'Could not read the activity. Try again.')
        } finally { if (turn === generation.current) setLoading(false) }
    }, [])

    // Typing in the search field waits a moment; every other filter reads at once.
    useEffect(() => {
        const stop = new AbortController()
        const timer = setTimeout(() => { void load(filters, stop.signal) }, filters.search ? 250 : 0)
        return () => { clearTimeout(timer); stop.abort() }
    }, [filters, load])

    const reveal = useCallback((rows: DesktopActivityRow[], counts?: Pick<DesktopActivityView, 'total' | 'dropped' | 'coworkers'>) => {
        if (!rows.length) return
        setFresh(new Set(rows.map(row => row.id)))
        setView(current => current && { ...current, ...counts, total: counts?.total ?? current.total + rows.length, rows: [...rows.filter(row => !current.rows.some(seen => seen.id === row.id)), ...current.rows] })
        setHeld([])
    }, [])

    // The same read the view opens with, made again quietly. What is new goes in at the top when the
    // person is there; further down, the list stays where it is and a pill says how many are waiting.
    const refresh = useCallback(async () => {
        const { view: current, filters: asked } = latest.current
        if (!current || refreshing.current || shownFilters.current !== asked || document.visibilityState === 'hidden') return
        const turn = generation.current
        refreshing.current = true
        try {
            const response = await fetch(`/api/desktop/activity?${desktopActivityQuery(asked)}`, { cache: 'no-store' })
            if (!response.ok) return
            const parsed = desktopActivityViewSchema.parse(await response.json())
            if (turn !== generation.current) return
            const now = latest.current
            const newest = Math.max(-1, ...(now.view?.rows ?? []).map(row => row.seq), ...now.held.map(row => row.seq))
            const arrived = parsed.rows.filter(row => row.seq > newest)
            const counts = { total: parsed.total, dropped: parsed.dropped, coworkers: parsed.coworkers }
            if (!arrived.length) {
                if (!now.held.length && now.view && (now.view.total !== parsed.total || now.view.dropped !== parsed.dropped)) setView(value => value && { ...value, ...counts })
                return
            }
            if ((scroller.current?.scrollTop ?? 0) <= AT_TOP_PX && !now.held.length) reveal(arrived, counts)
            else setHeld([...arrived, ...now.held])
        } catch { /* The next read tries again. */ }
        finally { refreshing.current = false }
    }, [reveal])

    useEffect(() => {
        const timer = setInterval(() => { void refresh() }, ACTIVITY_REFRESH_MS)
        const shown = () => { if (document.visibilityState !== 'hidden') void refresh() }
        document.addEventListener('visibilitychange', shown)
        return () => { clearInterval(timer); document.removeEventListener('visibilitychange', shown) }
    }, [refresh])

    function showHeld() {
        const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        scroller.current?.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' })
        reveal(latest.current.held)
    }

    async function loadMore() {
        if (!view?.next || more) return
        const turn = generation.current
        setMore(true)
        try {
            const response = await fetch(`/api/desktop/activity?${desktopActivityQuery(filters, view.next)}`, { cache: 'no-store' })
            if (!response.ok) throw new Error('Could not read more activity. Try again.')
            const parsed = desktopActivityViewSchema.parse(await response.json())
            if (turn !== generation.current) return
            setView(current => current && { ...parsed, rows: [...current.rows, ...parsed.rows.filter(row => !current.rows.some(seen => seen.id === row.id))] })
        } catch (failure) {
            if (turn === generation.current) setError(failure instanceof Error ? failure.message : 'Could not read more activity. Try again.')
        } finally { setMore(false) }
    }

    async function exportCsv() {
        setBusy('export')
        try { await downloadDesktopActivityCsv(filters, AbortSignal.timeout(60_000)); setError(null) }
        catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not export the activity. Try again.') }
        finally { setBusy(null) }
    }

    async function clear(coworker: string) {
        setBusy('clear')
        try {
            const response = await fetch(coworker ? `/api/desktop/activity?coworker=${encodeURIComponent(coworker)}` : '/api/desktop/activity', { method: 'DELETE', cache: 'no-store' })
            if (!response.ok) throw new Error((await response.json().then(body => typeof body?.error === 'string' && body.error, () => '')) || 'Could not clear the activity. Try again.')
            setConfirming(null)
            await load(filters)
        } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not clear the activity. Try again.') }
        finally { setBusy(null) }
    }

    const set = (change: Partial<DesktopActivityViewFilters>) => setFilters(current => ({ ...current, ...change }))
    const filtered = JSON.stringify(filters) !== JSON.stringify(EMPTY_ACTIVITY_FILTERS)
    const rows = view?.rows ?? []
    // Filtered to one coworker, Clear removes that coworker's rows only. The other filters never narrow it.
    const clearName = filters.coworker === 'deleted' ? 'deleted coworkers' : view?.coworkers.find(coworker => coworker.id === filters.coworker)?.name ?? ''
    const clearTarget = filters.coworker && clearName ? { coworker: filters.coworker, name: clearName } : filters.coworker ? null : { coworker: '', name: '' }
    const possessive = (name: string) => name === 'deleted coworkers' ? 'deleted coworkers’' : `${name}’s`
    const clearLabel = clearTarget?.coworker ? `Clear ${possessive(clearTarget.name)} activity` : 'Clear all activity'
    const otherFilters = JSON.stringify({ ...filters, coworker: '' }) !== JSON.stringify(EMPTY_ACTIVITY_FILTERS)
    const nothingToClear = !view || !clearTarget || (view.total === 0 && !otherFilters && (clearTarget.coworker ? true : !view.dropped))

    return <div className="flex min-h-0 flex-1 flex-col" data-testid="desktop-activity">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
            <Input aria-label="Search tools and apps" placeholder="Search tools and apps" className="h-8 w-44" value={filters.search} onChange={event => set({ search: event.target.value })} />
            <select aria-label="Coworker" className={selectClass} value={filters.coworker} onChange={event => set({ coworker: event.target.value })}>
                <option value="">All coworkers</option>
                {(view?.coworkers ?? []).map(coworker => <option key={coworker.id} value={coworker.id}>{coworker.name}</option>)}
                <option value="deleted">Deleted coworkers</option>
            </select>
            <select aria-label="Outcome" className={selectClass} value={filters.outcome} onChange={event => set({ outcome: event.target.value })}>
                <option value="">Any outcome</option>
                {DESKTOP_ACTIVITY_OUTCOMES.map(outcome => <option key={outcome} value={outcome}>{DESKTOP_ACTIVITY_OUTCOME_WORDS[outcome]}</option>)}
            </select>
            <select aria-label="Started by" className={selectClass} value={filters.source} onChange={event => set({ source: event.target.value })}>
                <option value="">Started anywhere</option>
                {DESKTOP_ACTIVITY_SOURCES.map(source => <option key={source} value={source}>{DESKTOP_ACTIVITY_SOURCE_WORDS[source]}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={filters.risky} onChange={event => set({ risky: event.target.checked })} /> Risky actions only</label>
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">From <input type="date" aria-label="From date" className={selectClass} value={filters.from} max={filters.to || undefined} onChange={event => set({ from: event.target.value })} /></label>
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">to <input type="date" aria-label="To date" className={selectClass} value={filters.to} min={filters.from || undefined} onChange={event => set({ to: event.target.value })} /></label>
            {filtered && <Button type="button" size="sm" variant="ghost" onClick={() => setFilters(EMPTY_ACTIVITY_FILTERS)}>Clear filters</Button>}
        </div>
        {!!view?.dropped && <p role="status" className="shrink-0 border-b bg-amber-500/10 px-4 py-2 text-sm">
            {view.dropped === 1 ? '1 action could not be recorded.' : `${view.dropped} actions could not be recorded.`} The coworkers’ work was not affected.
        </p>}
        {error && <p role="alert" className="shrink-0 border-b px-4 py-2 text-sm text-destructive">{error}</p>}
        <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto" onScroll={event => { if (held.length && event.currentTarget.scrollTop <= AT_TOP_PX) reveal(held) }}>
            {/* Takes no room of its own, so the rows under it do not move. */}
            {held.length > 0 && <div className="pointer-events-none sticky top-0 z-10 flex h-0 justify-center">
                <button type="button" data-activity-new-pill onClick={showHeld}
                    className={cn('pointer-events-auto mt-2 h-7 shrink-0 rounded-full border bg-background px-3 text-xs font-medium shadow-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring', DESKTOP_ARRIVE_TOP_CLASS)}>
                    {held.length} new<span className="sr-only">{held.length === 1 ? ' action. Show it.' : ' actions. Show them.'}</span>
                </button>
            </div>}
            {!view && loading && <div className="space-y-2 p-4" aria-busy="true"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
            {view && rows.length === 0 && <div className="mx-auto max-w-md space-y-2 p-10 text-center">
                <p className="font-medium">{filtered ? 'Nothing matches these filters' : 'No activity yet'}</p>
                <p className="text-sm text-muted-foreground">{filtered
                    ? 'Try a wider date range or clear the filters.'
                    : 'When a coworker uses a tool or an app, the action appears here: which coworker, when, in which conversation or routine, whether it was allowed by a permission, allowed once by you, declined or refused, and by which rule. Kept on this Mac for 90 days.'}</p>
            </div>}
            {rows.length > 0 && <ul className="divide-y">
                {rows.map(row => <ActivityRow key={row.id} row={row} fresh={fresh.has(row.id)} onOpenConversation={onOpenConversation} onError={setError} />)}
            </ul>}
            {view?.next && <div className="p-3 text-center"><Button type="button" size="sm" variant="outline" disabled={more} onClick={() => { void loadMore() }}>{more ? 'Loading…' : 'Show older activity'}</Button></div>}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t p-3">
            <p className="mr-auto text-sm text-muted-foreground" aria-live="polite">{view ? `${view.total} ${view.total === 1 ? 'action' : 'actions'}${filtered ? ' match' : ''}` : ''}</p>
            <Button type="button" size="sm" variant="outline" disabled={busy !== null || !view?.total} onClick={() => { void exportCsv() }}>{busy === 'export' ? 'Exporting…' : 'Export CSV'}</Button>
            <Button type="button" size="sm" variant="outline" disabled={busy !== null || nothingToClear} onClick={() => setConfirming(clearTarget)}>{clearLabel}</Button>
        </div>
        <ConfirmDialog open={confirming !== null} onOpenChange={open => { if (!open) setConfirming(null) }} pending={busy === 'clear'}
            title={confirming?.coworker ? `Clear ${possessive(confirming.name)} activity?` : 'Clear all activity?'}
            confirmLabel={confirming?.coworker ? `Clear ${possessive(confirming.name)} activity` : 'Clear activity'}
            description={confirming?.coworker
                ? `This removes every recorded action of ${confirming.name === 'deleted coworkers' ? 'coworkers that no longer exist' : confirming.name}, not only the rows shown. Other coworkers’ activity is kept. It cannot be undone. Conversations and run history are not changed.`
                : 'This removes every recorded action for every coworker in this workspace, not only the rows shown. It cannot be undone. Conversations and run history are not changed.'}
            onConfirm={event => { event.preventDefault(); if (confirming) void clear(confirming.coworker) }} />
    </div>
}

function ActivityRow({ row, fresh = false, onOpenConversation, onError }: { row: DesktopActivityRow; fresh?: boolean; onOpenConversation?: (target: { agentId: string; sessionId: string }) => Promise<void>; onError: (message: string) => void }) {
    const target = onOpenConversation && row.coworkerId && row.conversationId ? { agentId: row.coworkerId, sessionId: row.conversationId } : null
    const detail = [when(row.at), origin(row), row.ruleWords, row.durationMs === null ? null : `${row.durationMs < 1000 ? `${row.durationMs} ms` : `${(row.durationMs / 1000).toFixed(1)} s`}`].filter(Boolean).join(' · ')
    const body = <>
        <span className="flex items-start gap-2">
            <span className={cn('min-w-0 flex-1 text-sm', row.deleted && 'text-muted-foreground')}>{row.sentence}</span>
            <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs', TONE[row.outcome])}>{DESKTOP_ACTIVITY_OUTCOME_WORDS[row.outcome]}</span>
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span>
        {row.summary && <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={row.tool}>{row.summary}</span>}
    </>
    return <li data-activity-row data-outcome={row.outcome} data-activity-fresh={fresh ? '' : undefined} className={fresh ? DESKTOP_ARRIVE_TOP_CLASS : undefined}>
        {target
            ? <button type="button" className="block w-full px-4 py-2.5 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none" aria-label={`${row.sentence}. Open the conversation.`}
                onClick={() => { void onOpenConversation!(target).catch(failure => onError(failure instanceof Error ? failure.message : 'This conversation is no longer available.')) }}>{body}</button>
            : <div className="px-4 py-2.5">{body}</div>}
    </li>
}
