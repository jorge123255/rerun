'use client'

import type { TemplateCategory } from '@rerun/contracts'
import { HScrollFade, ScrollFade } from '@rerun/ui/primitives'
import { TemplateBoardPreview } from '@rerun/ui/iso-grid'
import { TemplateLibrarySearch } from '@/components/templates/TemplateLibrarySearch'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Grid2x2Icon, HammerIcon, PlusIcon, UploadIcon } from '@/lib/icons'
import { matchesQuery } from '@/lib/templates/library-view'
import { TEMPLATE_CATEGORY_ICONS } from '@/lib/templates/category-icons'
import { cn } from '@/lib/utils'
import { useMemo, useState } from 'react'
import { useDesktopLocale } from '../DesktopLocale'
import type { DesktopTemplateSummary } from './types'

type LibraryView = { kind: 'all' } | { kind: 'category'; category: TemplateCategory }

export function DesktopTemplateLibraryBrowser({ templates, loading, error, selected, onSelect, onScratch, onNewTemplate, onRetry, onImportPackage, importBusy = false, importError = null }: {
    templates: DesktopTemplateSummary[]
    loading: boolean
    error: string | null
    selected: string | null
    onSelect: (template: DesktopTemplateSummary) => void
    onScratch: () => void
    onNewTemplate: () => void
    onRetry: () => void
    onImportPackage?: () => void
    importBusy?: boolean
    importError?: string | null
}) {
    const { language, t } = useDesktopLocale()
    const copy = language.messages.templateLibrary
    const [view, setView] = useState<LibraryView>({ kind: 'all' })
    const [query, setQuery] = useState('')
    const categories = useMemo(() => {
        const counts = new Map<TemplateCategory, number>()
        for (const template of templates) counts.set(template.category, (counts.get(template.category) ?? 0) + 1)
        return [...counts].map(([category, count]) => ({ category, count }))
    }, [templates])
    const searching = query.trim() !== ''
    const filtered = searching || view.kind === 'category'
    // Like the web library, typing searches the whole catalog. Clearing returns to the chosen category.
    const listed = templates.filter(template => (searching || view.kind === 'all' || template.category === view.category)
        && matchesQuery(template, query))

    function navigate(next: LibraryView) {
        setView(next)
        setQuery('')
    }

    return <div className="flex min-h-0 w-full min-w-0 flex-1">
        <aside className="hidden w-60 shrink-0 flex-col border-r bg-muted/20 lg:flex">
            <div className="flex flex-col gap-3 px-3 pt-6 pb-3">
                <div className="flex items-baseline gap-2 px-2"><h2 className="font-heading text-lg leading-none font-semibold tracking-tight">{copy.templates}</h2>{!loading && !error && <span className="text-xs text-muted-foreground tabular-nums">{templates.length}</span>}</div>
                <TemplateLibrarySearch value={query} onChange={setQuery} labels={copy.search} />
            </div>
            <nav aria-label={copy.title} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
                <RailItem icon={Grid2x2Icon} label={copy.nav.mine} count={templates.length} active={view.kind === 'all' && !searching} onClick={() => navigate({ kind: 'all' })} />
                {categories.length > 0 && <p className="mt-6 mb-1.5 px-2.5 text-[11px] font-medium tracking-wider text-muted-foreground/80 uppercase">{copy.nav.categories}</p>}
                {categories.map(({ category, count }) => {
                    const Glyph = TEMPLATE_CATEGORY_ICONS[category] ?? TEMPLATE_CATEGORY_ICONS.other
                    return <RailItem key={category} icon={Glyph} label={copy.categories[category]} count={count} active={view.kind === 'category' && view.category === category && !searching} onClick={() => navigate({ kind: 'category', category })} />
                })}
            </nav>
            <div className="flex flex-col gap-2 border-t p-3">
                <Button type="button" variant="outline" onClick={onNewTemplate}><PlusIcon />{copy.newTemplate}</Button>
                {onImportPackage && <Button type="button" variant="outline" onClick={onImportPackage} disabled={importBusy} loading={importBusy}><UploadIcon />Import package</Button>}
                <Button type="button" onClick={onScratch}><PlusIcon />{t('creation.fromTemplateLibrary')}</Button>
            </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-col gap-3 border-b px-5 pt-5 pb-3 lg:hidden">
                <div className="flex flex-wrap items-center gap-2 pr-8">
                    <TemplateLibrarySearch value={query} onChange={setQuery} labels={copy.search} className="min-w-0 flex-1" />
                    <Button type="button" variant="outline" size="sm" onClick={onNewTemplate}><PlusIcon />{copy.newTemplate}</Button>
                    {onImportPackage && <Button type="button" variant="outline" size="sm" onClick={onImportPackage} disabled={importBusy} loading={importBusy}><UploadIcon />Import</Button>}
                    <Button type="button" size="sm" onClick={onScratch}><PlusIcon />{t('creation.title')}</Button>
                </div>
                <HScrollFade className="-mx-1 gap-1.5 px-1" fadeClassName="from-popover">
                    <NavChip active={view.kind === 'all' && !searching} onClick={() => navigate({ kind: 'all' })}>{copy.nav.mine}</NavChip>
                    {categories.map(({ category, count }) => <NavChip key={category} active={view.kind === 'category' && view.category === category && !searching} onClick={() => navigate({ kind: 'category', category })}>
                        {copy.categories[category]}<span className="text-xs text-muted-foreground">{count}</span>
                    </NavChip>)}
                </HScrollFade>
            </div>

            <ScrollFade className="@container min-h-0 flex-1 overflow-x-hidden">
                <div className="flex flex-col gap-6 px-5 pt-5 pb-10 lg:px-8 lg:pt-7">
                    <header className="flex items-center justify-between gap-4 pr-8">
                        <div><h2 className="font-heading text-2xl font-semibold tracking-tight">{searching ? t('templateLibrary.heading.results', { query: query.trim() }) : view.kind === 'category' ? copy.categories[view.category] : copy.nav.mine}</h2>
                            <p className="mt-1 text-sm text-muted-foreground">{copy.heading.mine}</p></div>
                    </header>
                    {importError && <p role="alert" className="text-sm text-destructive">{importError}</p>}
                    {loading ? <TemplateGridSkeleton /> : error ? <EmptyState icon={HammerIcon} title="Templates unavailable" description={error} action={<Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>} className="pt-8" /> : listed.length === 0 ? <EmptyState
                        icon={HammerIcon}
                        title={filtered ? copy.empty.filtered : copy.empty.none}
                        description={filtered ? undefined : copy.empty.selfHosted}
                        action={filtered ? <Button variant="outline" size="sm" onClick={() => navigate({ kind: 'all' })}>{copy.nav.mine}</Button> : <Button variant="outline" size="sm" onClick={onNewTemplate}>{copy.newTemplate}</Button>}
                        className="pt-8"
                    /> : <div className="grid grid-cols-1 gap-x-5 gap-y-8 @min-[28rem]:grid-cols-2 @min-[46rem]:grid-cols-3 @min-[62rem]:grid-cols-4">
                        {listed.map(template => <DesktopTemplateTile key={`${template.templateId}:${template.revision}`} template={template} selected={selected === template.templateId} onSelect={() => onSelect(template)} />)}
                    </div>}
                </div>
            </ScrollFade>
        </div>
    </div>
}

function DesktopTemplateTile({ template, selected, onSelect }: { template: DesktopTemplateSummary; selected: boolean; onSelect: () => void }) {
    const { language } = useDesktopLocale()
    return <button type="button" aria-pressed={selected} onClick={onSelect} className="group flex min-w-0 flex-col rounded-xl text-left outline-none">
        <span className={cn('relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl border bg-muted/40 transition-shadow', selected && 'ring-2 ring-primary', 'group-focus-visible:ring-3 group-focus-visible:ring-ring/50')}>
            {template.agents.length > 0 ? <TemplateBoardPreview agents={template.agents} connectors={[]} className="size-full" /> : <Grid2x2Icon className="size-8 opacity-30" />}
            <span className="absolute right-2 top-2 rounded-full bg-background/75 px-2 py-0.5 text-[10px] text-muted-foreground backdrop-blur">Private</span>
        </span>
        <span className="mt-3 truncate px-0.5 text-base leading-tight font-semibold tracking-tight">{template.title}</span>
        <span className="mt-1 truncate px-0.5 text-[13px] text-muted-foreground">{template.tagline || `${template.agents.length} coworker${template.agents.length === 1 ? '' : 's'}`}</span>
        <span className="mt-2.5 px-0.5 text-xs text-muted-foreground">{language.messages.templateLibrary.categories[template.category]}</span>
    </button>
}

function RailItem({ icon: Glyph, label, count, active, onClick }: { icon: typeof Grid2x2Icon; label: string; count: number; active: boolean; onClick: () => void }) {
    return <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined} className={cn('flex h-8 w-full shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px]', active ? 'bg-foreground/[0.07] font-medium text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground')}>
        <Glyph className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{label}</span><span className="text-xs tabular-nums">{count}</span>
    </button>
}

function NavChip({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
    return <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined} className={cn('flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] whitespace-nowrap', active ? 'border-foreground bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>{children}</button>
}

function TemplateGridSkeleton() {
    return <div role="status" aria-label="Loading templates" className="grid grid-cols-1 gap-x-5 gap-y-8 @min-[28rem]:grid-cols-2 @min-[46rem]:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => <div key={index} className="animate-pulse"><div className="aspect-video rounded-xl bg-muted" /><div className="mt-3 h-4 w-2/3 rounded bg-muted" /><div className="mt-2 h-3 w-1/2 rounded bg-muted" /></div>)}
    </div>
}
