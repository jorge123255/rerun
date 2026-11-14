'use client'

import { useEffect, useRef, useState } from 'react'
import { StepTransition, useStepper } from '@rerun/ui/steps'
import { ChangelogDots } from '@/components/changelog/ChangelogDots'
import { SplitDialogContent } from '@/components/dialogs/SplitDialogContent'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { desktopChangelogFeed, DESKTOP_CHANGELOG_FRESH_MS, DESKTOP_CHANGELOG_URL, type DesktopChangelogEntry, type DesktopChangelogFeed } from '@/lib/desktop/changelog'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { useDesktopLocale } from '../DesktopLocale'

const endpoint = '/api/desktop/changelog'

export function useDesktopChangelog(launchNonce: string | undefined, ready: boolean) {
    const [mode, setMode] = useState<'latest' | 'unread' | null>(null)
    const [attempt, setAttempt] = useState(0)
    const [answer, setAnswer] = useState<{ scope: string; feed: DesktopChangelogFeed | null } | null>(null)
    const handled = useRef<string | undefined>(undefined)
    const scope = JSON.stringify([launchNonce, attempt])
    const feed = answer?.scope === scope ? answer.feed : null
    const loaded = answer?.scope === scope
    const native = typeof window !== 'undefined' && !!(window as Window & { desktopApp?: { getStatus?: unknown } }).desktopApp?.getStatus
    const requested = mode !== null
    const enabled = !!launchNonce && (native || requested)

    useEffect(() => {
        if (!enabled) return
        const abort = new AbortController()
        void fetch(endpoint, { signal: abort.signal, cache: 'no-store' }).then(async response => {
            if (!response.ok) throw new Error('Changelog unavailable')
            const feed = desktopChangelogFeed.parse(await response.json())
            if (!abort.signal.aborted) setAnswer({ scope, feed })
        }).catch(() => { if (!abort.signal.aborted) setAnswer({ scope, feed: null }) })
        return () => abort.abort()
    }, [enabled, scope])

    useEffect(() => {
        if (!launchNonce || !native || !ready || mode || !feed || handled.current === launchNonce) return
        const frame = requestAnimationFrame(() => {
            if (isDesktopQuitting() || document.querySelector('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]')) return
            handled.current = launchNonce
            if (feed.entries.some(entry => entry.publishedAt > feed.seenAt && Date.now() - Date.parse(entry.publishedAt) < DESKTOP_CHANGELOG_FRESH_MS)) {
                setMode('unread')
            }
        })
        return () => cancelAnimationFrame(frame)
    }, [launchNonce, ready, native, mode, feed])

    const entries = feed?.entries.filter(entry => mode !== 'unread' || entry.publishedAt > feed.seenAt) ?? []
    return {
        open: requested,
        loading: !loaded,
        failed: loaded && (!feed || feed.stale && !entries.length),
        stale: !!feed?.stale,
        entries,
        show: () => {
            handled.current = launchNonce
            setMode('latest')
            if (loaded && (!feed || feed.stale)) setAttempt(value => value + 1)
        },
        retry: () => setAttempt(value => value + 1),
        close: () => {
            const first = entries[0]
            setMode(null)
            if (!first || !feed || first.publishedAt <= feed.seenAt || isDesktopQuitting()) return
            const { slug, publishedAt } = first
            void fetch(endpoint, {
                method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug, publishedAt }), keepalive: true,
            }).then(response => {
                if (response.ok) setAnswer(current => current?.scope === scope && current.feed && current.feed.seenAt < publishedAt
                    ? { ...current, feed: { ...current.feed, seenAt: publishedAt } } : current)
            }).catch(() => {})
        },
    }
}

type State = ReturnType<typeof useDesktopChangelog>

export function DesktopChangelog({ state }: { state: State }) {
    const { t } = useDesktopLocale()
    if (!state.open) return null
    return (
        <Dialog open onOpenChange={open => { if (!open) state.close() }}>
            {state.entries.length ? <ChangelogSlides key={state.entries[0].slug} entries={state.entries} close={state.close} stale={state.stale} /> : (
                <DialogContent closeLabel={t('closeDialog')} className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t('helpItems.whats_new')}</DialogTitle>
                        <DialogDescription role={state.failed ? 'alert' : 'status'}>
                            {t(state.loading ? 'changelog.loading' : state.failed ? 'changelog.unavailable' : 'changelog.empty')}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <AllUpdates className="mr-auto" />
                        {state.failed && <Button onClick={state.retry}>{t('changelog.retry')}</Button>}
                    </DialogFooter>
                </DialogContent>
            )}
        </Dialog>
    )
}

function AllUpdates({ className = '' }: { className?: string }) {
    const { t } = useDesktopLocale()
    return <a className={`text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline ${className}`}
        href={DESKTOP_CHANGELOG_URL} target="_blank" rel="noopener noreferrer">{t('changelog.seeAll')}</a>
}

function ChangelogSlides({ entries, close, stale }: { entries: DesktopChangelogEntry[]; close: () => void; stale: boolean }) {
    const { t, language } = useDesktopLocale()
    const { index, direction, isFirst, isLast, goForward, back } = useStepper(entries.length)
    const entry = entries[index]
    if (!entry) return null
    const date = new Intl.DateTimeFormat(desktopLocaleTag(language.locale), { month: 'short', day: 'numeric' }).format(new Date(entry.publishedAt))
    const visual = <div className="relative order-first hidden overflow-hidden border-l bg-muted/30 sm:order-none sm:block">
        <StepTransition stepKey={entry.slug} direction={direction} className="absolute inset-0">
            {entry.image && <ChangelogImage url={entry.image} alt={entry.imageAlt} className={entry.darkImage ? 'dark:hidden' : ''} />}
            {entry.darkImage && <ChangelogImage url={entry.darkImage} alt={entry.imageAlt} className="hidden dark:block" />}
        </StepTransition>
    </div>
    const content = <div className="flex min-h-0 flex-col p-6 sm:p-8">
        <div className="min-h-0 flex-1 overflow-y-auto">
            <StepTransition stepKey={entry.slug} direction={direction}>
                <p className="pt-2 font-mono text-xs tracking-widest text-muted-foreground uppercase sm:pt-6">{t('changelog.eyebrow', { date })}</p>
                <DialogTitle className="mt-4 font-heading text-2xl leading-tight font-medium text-balance sm:text-3xl">{entry.title}</DialogTitle>
                <DialogDescription className="mt-4 whitespace-pre-line">{entry.body}</DialogDescription>
                <a href={DESKTOP_CHANGELOG_URL + '#' + entry.slug} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-sm underline underline-offset-4">{t('changelog.readUpdate')}</a>
            </StepTransition>
        </div>
        {stale && <p role="status" className="py-2 text-xs text-muted-foreground">{t('changelog.saved')}</p>}
        <DialogFooter className="-mx-6 mt-auto -mb-6 flex-row flex-wrap items-center gap-x-4 gap-y-2 border-t bg-muted/50 px-6 py-4 sm:-mx-8 sm:-mb-8 sm:px-8">
            <ChangelogDots count={entries.length} current={index} />
            <AllUpdates />
            <div className="ml-auto flex items-center gap-2">
                {!isFirst && <Button variant="ghost" onClick={back}>{t('changelog.back')}</Button>}
                <Button onClick={isLast ? close : goForward}>{t(isLast ? 'changelog.done' : 'changelog.next')}</Button>
            </div>
        </DialogFooter>
    </div>
    return (
        <SplitDialogContent aside={visual} closeLabel={t('closeDialog')} className="sm:max-w-[min(64rem,100%_-_4rem)]"
            gridClassName="sm:h-[min(38.5rem,90dvh)]">{content}</SplitDialogContent>
    )
}

function ChangelogImage({ url, alt, className }: { url: string; alt: string; className: string }) {
    // eslint-disable-next-line @next/next/no-img-element -- Published changelog art uses Rerun's fixed asset origin.
    return <img src={url} alt={alt} referrerPolicy="no-referrer" className={`size-full object-contain ${className}`} />
}
