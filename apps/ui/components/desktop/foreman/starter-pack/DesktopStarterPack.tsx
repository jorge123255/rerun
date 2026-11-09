'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StarterPackRail } from '@/components/foreman/widgets/starter-pack/StarterPackRail'
import type { StarterPicks } from '@/components/foreman/widgets/starter-pack/useStarterPicks'
import { Button } from '@/components/ui/button'
import type { DesktopTemplatesClient } from '@/lib/desktop/templates-client'
import type { DesktopTemplateIdentity, DesktopTemplateSummary } from '@/components/desktop/templates/types'
import { starterRailCard } from './starter-pack'
import { useDesktopStarterPack } from './useDesktopStarterPack'

/**
 * The Foreman's starter-pack rail, filled from this workspace's own templates.
 *
 * The hosted rail is written by the onboarding script and installs on pick; here a pick only
 * chooses, and Review opens the template's own review in the library. No coworker is created from
 * this component, so the rail cannot install anything the person has not confirmed.
 *
 * Only genuinely available templates are offered, a duplicate press is ignored while the review is
 * being opened, and changing workspace drops the selection and the cards of the previous one.
 */
export function DesktopStarterPack({ workspaceId, active, onReviewTemplate, client }: {
    workspaceId: string
    active: boolean
    onReviewTemplate: (template: DesktopTemplateIdentity) => void
    /** Injected in tests; the panel owns the real client lifetime. */
    client?: DesktopTemplatesClient
}) {
    const { templates, loading, error, reload } = useDesktopStarterPack({ workspaceId, active, client })
    const [picked, setPicked] = useState<string | null>(null)
    const opening = useRef<string | null>(null)

    // Another workspace starts clean, and the same selection can be reviewed again once the
    // library was closed: the latch only stops the second press of one opening.
    useEffect(() => {
        setPicked(null)
        opening.current = null
    }, [workspaceId, active])
    useEffect(() => { opening.current = null }, [picked])

    const cards = useMemo(() => templates.map(starterRailCard), [templates])
    const bySlug = useMemo(() => new Map(templates.map(template => [template.templateId, template])), [templates])
    const chosen: DesktopTemplateSummary | null = picked ? bySlug.get(picked) ?? null : null

    const picks: StarterPicks = useMemo(() => ({
        picked: picked ? [picked] : [],
        // One template is reviewed at a time: there is no second place to take on this rail.
        full: false,
        blocked: null,
        isPicked: slug => slug === picked,
        toggle: slug => setPicked(current => (current === slug ? null : slug)),
    }), [picked])

    const review = useCallback(() => {
        if (!chosen || opening.current === chosen.templateId) return
        opening.current = chosen.templateId
        onReviewTemplate({ templateId: chosen.templateId, revision: chosen.revision })
    }, [chosen, onReviewTemplate])

    if (!active) return null

    if (loading) {
        return <div data-desktop-starter-pack className="mb-2 flex flex-col gap-2" aria-busy="true">
            <p className="text-sm font-medium text-foreground">Start from a template</p>
            <div aria-hidden className="h-40 w-full animate-pulse rounded-xl bg-muted" />
        </div>
    }

    if (error) {
        return <div data-desktop-starter-pack className="mb-2 flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
            <p role="alert" className="text-sm text-destructive">{error}</p>
            <Button size="sm" variant="outline" className="self-start" onClick={reload}>Try again</Button>
        </div>
    }

    // Genuinely nothing to offer: no empty rail and no button that cannot work.
    if (cards.length === 0) return null

    return <div data-desktop-starter-pack className="mb-2 flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
            <p className="text-sm font-medium text-foreground">Start from a template</p>
            <p className="text-xs text-muted-foreground">This workspace&apos;s templates. You review what one carries before any coworker is created.</p>
        </div>

        <StarterPackRail cards={cards} picks={picks} />

        <div className="flex flex-wrap-reverse items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{chosen ? chosen.title : 'Pick one to review it'}</span>
            <Button size="sm" disabled={!chosen} onClick={review}>
                {chosen ? `Review ${chosen.title}` : 'Review'}
            </Button>
        </div>
    </div>
}
