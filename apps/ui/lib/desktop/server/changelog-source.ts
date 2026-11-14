import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import { z } from 'zod'
import { changelogEntries, changelogImage, changelogSlug, DESKTOP_CHANGELOG_LIMIT, DESKTOP_CHANGELOG_URL } from '../changelog'

type Node = DefaultTreeAdapterTypes.Node
type Element = DefaultTreeAdapterTypes.Element

function* walk(root: Node, skip: ReadonlySet<string> = new Set()): Generator<Node> {
    const stack = [root]
    for (let node = stack.pop(); node; node = stack.pop()) {
        yield node
        if ('tagName' in node && skip.has(node.tagName)) continue
        if ('childNodes' in node) for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i])
    }
}

const attr = (node: Element, name: string) => node.attrs.find(attribute => attribute.name === name)?.value
const ignored = new Set(['script', 'style', 'template', 'noscript'])

function textOf(node: Node, skip = ignored): string {
    let result = ''
    for (const part of walk(node, skip)) {
        if ('value' in part && part.nodeName === '#text') result += part.value
        if ('tagName' in part && part.tagName === 'br') result += '\n'
    }
    return result.trim()
}

const metadata = z.object({
    '@type': z.literal('CollectionPage'),
    url: z.literal(DESKTOP_CHANGELOG_URL),
    hasPart: z.array(z.unknown()),
})
const itemSchema = z.object({
    '@type': z.literal('CreativeWork'),
    headline: z.string().trim().min(1).max(300),
    url: z.string(),
    datePublished: z.iso.datetime({ offset: true }),
    image: z.unknown().optional(),
})

/** Read only the public changelog's structured catalogue and matching semantic articles. */
export function parsePublishedChangelog(html: string, now = Date.now()) {
    const articles = new Map<string, Element>()
    let items: unknown[] | undefined
    for (const node of walk(parse(html))) {
        if (!('tagName' in node)) continue
        if (node.tagName === 'article') {
            const id = attr(node, 'id')
            if (id && !articles.has(id)) articles.set(id, node)
        } else if (!items && node.tagName === 'script' && attr(node, 'type') === 'application/ld+json') {
            try {
                const parsed = metadata.safeParse(JSON.parse(textOf(node, new Set())))
                if (parsed.success) items = parsed.data.hasPart
            } catch { /* A separate structured-data block may be present. */ }
        }
    }
    if (!items) throw new Error('Missing Rerun changelog catalogue')
    const prefix = DESKTOP_CHANGELOG_URL + '#'
    const seen = new Set<string>()
    const entries = items.flatMap(item => {
        const parsed = itemSchema.safeParse(item)
        if (!parsed.success || !parsed.data.url.startsWith(prefix)) return []
        const { url, headline, datePublished, image } = parsed.data
        const slug = url.slice(prefix.length)
        const timestamp = Date.parse(datePublished)
        if (!changelogSlug.safeParse(slug).success || seen.has(slug) || !Number.isFinite(timestamp) || timestamp > now) return []
        seen.add(slug)
        const article = articles.get(slug)
        const blocks: string[] = []
        let imageAlt = ''
        let darkImage: string | null = null
        const imageUrl = changelogImage.safeParse(image).data ?? null
        if (article) {
            const elements = [...walk(article, ignored)].filter((node): node is Element => 'tagName' in node && !ignored.has(node.tagName))
            const heading = elements.findIndex(node => node.tagName === 'h2')
            const blockParents = new Set<Node>()
            for (const node of elements.slice(0, heading < 0 ? 0 : heading)) {
                if (node.tagName !== 'img') continue
                const src = attr(node, 'src')
                if (imageUrl && src === imageUrl) imageAlt = attr(node, 'alt')?.slice(0, 500) ?? ''
                if (imageUrl && attr(node, 'class')?.split(/\s+/).includes('dark:block')) darkImage = changelogImage.safeParse(src).data ?? null
            }
            for (const node of elements.slice(heading < 0 ? elements.length : heading + 1)) {
                if (!['p', 'li', 'h2', 'h3', 'h4', 'pre'].includes(node.tagName)) continue
                let parent = node.parentNode
                while (parent && !blockParents.has(parent)) parent = 'parentNode' in parent ? parent.parentNode : null
                if (parent) continue
                blockParents.add(node)
                const content = textOf(node)
                if (content) blocks.push(node.tagName === 'li' ? '• ' + content : content)
            }
        }
        return [{ slug, title: headline, publishedAt: new Date(timestamp).toISOString(), body: blocks.join('\n\n').slice(0, 12000), image: imageUrl, darkImage, imageAlt }]
    })
    entries.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    if (!entries.length && items.length) throw new Error('Rerun changelog entries unavailable')
    return changelogEntries.parse(entries.slice(0, DESKTOP_CHANGELOG_LIMIT))
}
