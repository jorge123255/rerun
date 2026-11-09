import type { StarterPackCard as StarterRailCard } from '@/lib/foreman/starter-pack'
import type { DesktopTemplateSummary } from '@/components/desktop/templates/types'

/** `list()` gives a draft this tagline and no agents: it has nothing to install yet. */
const DRAFT_TAGLINE = 'Draft — not captured'

/**
 * The templates this workspace can actually install right now: captured, with a revision and at
 * least one coworker to land. A draft, an empty template and a duplicate row drop out, so the rail
 * never offers a card whose install would immediately refuse.
 */
export function availableStarterTemplates(templates: readonly DesktopTemplateSummary[]): DesktopTemplateSummary[] {
    const seen = new Set<string>()
    return templates.filter(template => {
        if (!template.templateId || !template.revision) return false
        if (!template.agents?.length) return false
        if (template.tagline === DRAFT_TAGLINE) return false
        if (seen.has(template.templateId)) return false
        seen.add(template.templateId)
        return true
    })
}

/** The local template as the shared starter-pack card draws it: same rail, same card, local data. */
export function starterRailCard(template: DesktopTemplateSummary): StarterRailCard {
    return {
        slug: template.templateId,
        promise: template.title,
        line: template.tagline === DRAFT_TAGLINE ? '' : template.tagline,
        title: template.title,
        agent: template.agents[0]?.name ?? template.title,
        image: null,
        connectors: [],
    }
}
