const MESSAGE = '[data-chat-find-message]'
const IGNORE = '[hidden],[inert],[aria-hidden="true"],.sr-only,[data-chat-find-ignore],script,style,input,textarea,select'
const BLOCK = 'address,article,blockquote,dd,div,dt,figcaption,figure,h1,h2,h3,h4,h5,h6,li,p,pre,section,td,th'
const ALL_HIGHLIGHTS = 'rerun-chat-find'
const CURRENT_HIGHLIGHT = 'rerun-chat-find-current'

type Chunk = { node: Text; url: string | null }
type Match = { first: number; last: number; start: number; end: number }

function visible(element: Element) {
    if (element.matches(IGNORE) || (element.parentElement?.matches('details:not([open])') && element.tagName !== 'SUMMARY')) return false
    const style = getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
}

/** Match inline text as one string within each block of each visible transcript row. */
export function findTranscriptRanges(transcript: HTMLElement, query: string): Range[] {
    const text = query.trim()
    if (!text || text.length > 200) return []
    const pattern = new RegExp(text.split(/\s+/).map(word => word.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')).join('\\s+'), 'giu')
    const doc = transcript.ownerDocument
    const ranges: Range[] = []
    for (const message of transcript.querySelectorAll(MESSAGE)) {
        if (!visible(message)) continue
        const walker = doc.createTreeWalker(message, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
            acceptNode(node) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    const element = node as Element
                    if (!visible(element)) return NodeFilter.FILTER_REJECT
                    return element.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
                }
                return node.parentElement?.matches('details:not([open])') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
            },
        })
        let chunks: Chunk[] = [], block: Element | null = null
        function finishBlock() {
            const found = new Map<string, Match>()
            function matchText(fullUrls: boolean) {
                const offsets: number[] = []
                let content = ''
                for (const { node, url } of chunks) {
                    offsets.push(content.length)
                    content += fullUrls && url ? url : node.data
                }
                let from = 0, to = 0
                for (const match of content.matchAll(pattern)) {
                    const start = match.index
                    const end = start + match[0].length
                    while (from + 1 < chunks.length && offsets[from + 1] <= start) from++
                    to = Math.max(from, to)
                    while (to + 1 < chunks.length && offsets[to + 1] < end) to++
                    const firstOffset = chunks[from].url ? 0 : start - offsets[from]
                    const lastOffset = chunks[to].url ? chunks[to].node.length : end - offsets[to]
                    found.set(`${from}:${firstOffset}:${to}:${lastOffset}`, { first: from, last: to, start: firstOffset, end: lastOffset })
                }
            }
            matchText(false)
            // A compact label and its original URL both find the same visible chip.
            if (chunks.some(chunk => chunk.url)) matchText(true)
            for (const { first, last, start, end } of [...found.values()].sort((a, b) => a.first - b.first || a.start - b.start)) {
                const range = doc.createRange()
                range.setStart(chunks[first].node, start)
                range.setEnd(chunks[last].node, end)
                ranges.push(range)
            }
            chunks = []
        }

        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.nodeType === Node.ELEMENT_NODE) { finishBlock(); continue }
            const part = node as Text
            if (!part.data) continue
            const currentBlock = part.parentElement?.closest(BLOCK) ?? message
            if (currentBlock !== block) {
                finishBlock()
                block = currentBlock
            }
            chunks.push({ node: part, url: part.parentElement?.closest('[data-chat-find-url]')?.getAttribute('data-chat-find-url') ?? null })
        }
        finishBlock()
    }
    return ranges
}

/** Keep the renderer DOM and the user's text selection intact while painting matches. */
export function paintTranscriptFind(ranges: Range[], current: Range) {
    const registry = globalThis.CSS?.highlights
    if (!registry || typeof Highlight !== 'function') return
    const all = new Highlight()
    for (const range of ranges) all.add(range)
    const active = new Highlight(current)
    active.priority = 1
    registry.set(ALL_HIGHLIGHTS, all)
    registry.set(CURRENT_HIGHLIGHT, active)
    return () => {
        if (registry.get(ALL_HIGHLIGHTS) === all) registry.delete(ALL_HIGHLIGHTS)
        if (registry.get(CURRENT_HIGHLIGHT) === active) registry.delete(CURRENT_HIGHLIGHT)
    }
}
