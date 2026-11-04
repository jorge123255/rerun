import { describe, expect, it } from 'vitest'
import { pageFacts, stripHtml } from './page-facts.js'
import { MAX_HTML_TOKENS } from './html-tokens.js'

const FULL_PAGE = `<!doctype html>
<html lang="en">
<head>
    <title>Altarflow &amp; Church Giving</title>
    <meta name="description" content="Online giving for churches">
    <meta name="robots" content="index, follow">
    <link rel="canonical" href="/">
    <link rel="alternate" hreflang="en" href="https://altarflow.com/">
    <link rel="alternate" hreflang="es" href="/es">
    <link rel="alternate" hreflang="x-default" href="https://altarflow.com/">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":["WebSite","CreativeWork"]}]}</script>
    <script type="application/ld+json">{ not json</script>
</head>
<body>
    <header><nav><a href="/pricing">Pricing</a><a href="/compare">Compare</a><a href="https://www.altarflow.com/es">ES</a></nav></header>
    <h1>Giving made <em>simple</em></h1>
    <p>Body text <a href="/blog/post">read</a> <a href="https://stripe.com">Stripe</a> <a href="mailto:hi@altarflow.com">mail</a> <a href="#top">top</a></p>
    <footer><a href="/privacy">Privacy</a><a href="/pricing">Pricing</a></footer>
</body>
</html>`

describe('pageFacts', () => {
    it('reads the head, the JSON-LD and the links a crawler sees', () => {
        expect(pageFacts(FULL_PAGE, { url: 'https://altarflow.com/', source: 'served' })).toBe(
            [
                'Page facts (HTML as served, before JavaScript):',
                'title: Altarflow & Church Giving',
                'description: Online giving for churches',
                'canonical: https://altarflow.com/',
                'robots: meta robots: index, follow',
                'lang: en',
                'hreflang: en → /, es → /es, x-default → /',
                'JSON-LD: Organization, WebSite, CreativeWork',
                'h1: "Giving made simple"',
                'links: 5 internal, 1 external',
                'nav/header/footer links: /pricing, /compare, /es, /privacy',
                'other internal links: /blog/post',
                `visible text: ${'Altarflow &amp; Church Giving Pricing Compare ES Giving made simple Body text read Stripe mail top Privacy Pricing'.length} chars`,
            ].join('\n'),
        )
    })

    it('says none for every tag a page lacks, so an absence is stated rather than guessed', () => {
        const facts = pageFacts('<html><body><h1>Hi</h1></body></html>', { url: 'https://example.com/', source: 'served' })
        expect(facts).toContain('title: none')
        expect(facts).toContain('description: none')
        expect(facts).toContain('canonical: none')
        expect(facts).toContain('robots: none set')
        expect(facts).toContain('hreflang: none')
        expect(facts).toContain('JSON-LD: none')
        expect(facts).toContain('nav/header/footer links: none')
        expect(facts).toContain('other internal links: none')
    })

    it('shows how little text a JavaScript shell serves', () => {
        const facts = pageFacts('<html lang="en"><head><title>App</title><script src="/main.js"></script></head><body><div id="root"></div></body></html>', { url: 'https://app.test/', source: 'served' })
        expect(facts).toContain('visible text: 3 chars')
    })

    it('adds the robots header and the redirect the fetch followed', () => {
        const facts = pageFacts('<title>Old</title>', { url: 'http://acme.com/old', source: 'served', xRobotsTag: 'noindex', redirectedTo: 'https://acme.com/new' })
        expect(facts).toContain('robots: X-Robots-Tag: noindex')
        expect(facts).toContain('redirected to: https://acme.com/new')
    })

    it('names a page read after JavaScript as such', () => {
        expect(pageFacts('<title>App</title>', { url: 'https://app.test/', source: 'rendered' })).toMatch(/^Page facts \(HTML after JavaScript, read through Rerun\):/)
    })

    it('lists the internal links of a page whose menu is not in a nav, header or footer', () => {
        const facts = pageFacts('<div class="menu"><a href="./comparescreeners.html">Compare</a><a href="/">Home</a></div>', { url: 'https://www.mometic.com/', source: 'served' })
        expect(facts).toContain('nav/header/footer links: none')
        expect(facts).toContain('other internal links: /comparescreeners.html, /')
    })

    it('caps long lists', () => {
        const nav = Array.from({ length: 40 }, (_, i) => `<a href="/p${i}">p</a>`).join('')
        const facts = pageFacts(`<nav>${nav}</nav>`, { url: 'https://acme.com/', source: 'served' })
        expect(facts).toContain('/p29 (+10 more)')
    })

    it('leaves an entity past the last code point as written instead of failing', () => {
        const facts = pageFacts('<title>Hi &#1114112; &#xFFFFFFFF; &#233;</title>', { url: 'https://a.test/', source: 'served' })
        expect(facts).toContain('title: Hi &#1114112; &#xFFFFFFFF; é')
    })

    it('returns null for a body that carries no HTML structure', () => {
        expect(pageFacts('{"ok":true}', { url: 'https://api.test/', source: 'served' })).toBeNull()
    })

    it('reads malformed openers without rescanning every remaining suffix', () => {
        const malformed = '<'.repeat(900_000)
        expect(stripHtml(malformed)).toBe(malformed)
        expect(pageFacts(malformed, { url: 'https://example.com/', source: 'served' })).toBeNull()
        const unfinished = '<meta '.repeat(100_000)
        expect(stripHtml(unfinished)).toBe(unfinished.trim())
        expect(pageFacts(unfinished, { url: 'https://example.com/', source: 'served' })).toBeNull()
    })

    it('refuses excessive element and attribute counts instead of returning partial facts', () => {
        expect(() => pageFacts('<h1>Safe</h1>' + '<i>'.repeat(MAX_HTML_TOKENS), { url: 'https://example.com/', source: 'served' })).toThrow('too many elements')
        const attributes = Array.from({ length: 129 }, (_, index) => `a${index}="x"`).join(' ')
        expect(() => stripHtml(`<div ${attributes}>hello</div>`)).toThrow('too many attributes')
    })

    it('excludes markup inside comments and unclosed script/style bodies from page facts', () => {
        const hidden = '<meta name="description" content="Fake"><a href="/fake">Fake</a>'
        const page = `<title>Real</title><!-- ${hidden} --><script>${'<script>'.repeat(50_000)}${hidden}`
        const facts = pageFacts(page, { url: 'https://example.com/', source: 'served' })
        expect(facts).toContain('title: Real')
        expect(facts).toContain('description: none')
        expect(facts).toContain('links: 0 internal, 0 external')
        expect(stripHtml(page)).toBe('Real')
        expect(stripHtml('Visible<style>' + '<style>'.repeat(50_000))).toBe('Visible')
        // In HTML, the slash does not make a script/style element self-closing.
        expect(stripHtml(`Visible<script/>${hidden}`)).toBe('Visible')
    })

    it('keeps raw-text boundaries correct after Unicode whose lowercase expands', () => {
        expect(stripHtml('İ<script>hidden</script><h1>Visible</h1>')).toBe('İ Visible')
        expect(pageFacts('İ<script>hidden</script><h1>Visible</h1>', { url: 'https://example.com/', source: 'served' })).toContain('h1: "Visible"')
    })

    it('handles deep JSON-LD arrays iteratively and preserves discovered types', () => {
        const data = '['.repeat(12_000) + '{"@type":"Article"}' + ']'.repeat(12_000)
        expect(pageFacts(`<script type="application/ld+json">${data}</script>`, { url: 'https://example.com/', source: 'served' })).toContain('JSON-LD: Article')
    })

    it('reads quoted angle brackets and keeps nested navigation links in original order', () => {
        const facts = pageFacts('<meta name="description" content="A > B"><header><nav><a href="/one">One</a></nav><a href="/two">Two</a></header><a href="/other">Other</a>', { url: 'https://example.com/', source: 'served' })
        expect(facts).toContain('description: A > B')
        expect(facts).toContain('nav/header/footer links: /one, /two')
        expect(facts).toContain('other internal links: /other')
    })
})
