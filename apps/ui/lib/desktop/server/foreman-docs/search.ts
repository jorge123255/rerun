import { DESKTOP_FOREMAN_DOCS_LIMITS, isDesktopForemanDocsCitation } from '@rerun/contracts'

export type DesktopForemanDocsSection = { page: string; heading: string | null; url: string; body: string }

export function parseDesktopForemanDocs(text: string): DesktopForemanDocsSection[] {
    const pages = [...text.matchAll(/^# (.+)[\r\n]+Source: (\S+)[^\n]*$/gm)]
    return pages.flatMap((page, index) => {
        const start = (page.index ?? 0) + page[0].length
        const end = index + 1 < pages.length ? (pages[index + 1].index ?? text.length) : text.length
        const source = citation(page[2].trim())
        return source ? splitByHeading(text.slice(start, end), page[1].trim(), source) : []
    })
}

function citation(value: string): string | null {
    try {
        const url = new URL(value)
        url.hash = ''
        return isDesktopForemanDocsCitation(url.href) ? url.href : null
    } catch {
        return null
    }
}

function splitByHeading(body: string, page: string, url: string): DesktopForemanDocsSection[] {
    const headings = [...body.matchAll(/^## (.+)$/gm)]
    const intro = { page, heading: null, url, body: body.slice(0, headings[0]?.index ?? body.length).trim() }
    const sections = headings.map((heading, index) => ({
        page,
        heading: heading[1].trim(),
        url: `${url}#${anchor(heading[1])}`,
        body: body.slice(heading.index ?? 0, index + 1 < headings.length ? (headings[index + 1].index ?? body.length) : body.length).trim(),
    }))
    return [intro, ...sections].filter(section => section.body.length > 0)
}

function anchor(heading: string): string {
    return heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

const IGNORED_TERMS = new Set(['the', 'and', 'for', 'with', 'you', 'your', 'that', 'this', 'what', 'how', 'why', 'when', 'does', 'can', 'are', 'from', 'about', 'rerun', 'agent', 'agents'])

function queryTerms(query: string): string[] {
    const words = query.toLowerCase().match(/[a-z0-9]+/g) ?? []
    const kept = [...new Set(words)].filter(word => word.length > 2 && !IGNORED_TERMS.has(word))
    return kept.length ? kept : [...new Set(words)].filter(word => word.length > 2)
}

export function rankDesktopForemanDocs(sections: DesktopForemanDocsSection[], query: string, limit = DESKTOP_FOREMAN_DOCS_LIMITS.passageLimit): DesktopForemanDocsSection[] {
    const terms = queryTerms(query)
    if (!terms.length) return []
    const scored = sections.map(section => ({ section, score: scoreSection(section, terms) })).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score)
    const perPage = new Map<string, number>()
    const picked: DesktopForemanDocsSection[] = []
    for (const { section } of scored) {
        const taken = perPage.get(section.page) ?? 0
        if (taken >= DESKTOP_FOREMAN_DOCS_LIMITS.passagesPerPage) continue
        perPage.set(section.page, taken + 1)
        picked.push(section)
        if (picked.length === limit) break
    }
    return picked
}

function scoreSection(section: DesktopForemanDocsSection, terms: string[]): number {
    const body = section.body.toLowerCase()
    const title = `${section.page} ${section.heading ?? ''}`.toLowerCase()
    let score = 0
    let matched = 0
    for (const term of terms) {
        const hits = Math.min(occurrences(body, term), 5)
        if (hits) matched += 1
        score += hits + (title.includes(term) ? 6 : 0)
    }
    return score ? score + matched * 10 : 0
}

function occurrences(haystack: string, term: string): number {
    let count = 0
    let from = 0
    for (;;) {
        const at = haystack.indexOf(term, from)
        if (at === -1) return count
        count += 1
        from = at + term.length
    }
}

export function desktopForemanDocsSectionTitle(section: DesktopForemanDocsSection): string {
    return section.heading ? `${section.page} - ${section.heading}` : section.page
}
