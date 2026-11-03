// @vitest-environment happy-dom
import type { UIMessage } from 'ai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { desktopSummaryMetadata } from '@/lib/desktop/reasoning-summary'
import { DesktopAssistantReply } from './DesktopAssistantReply'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
})
afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(document, 'execCommand')
})
const markdown = [
    '## Desk notes', '', '1. First item', '2. Second item', '', '| Name | Count |', '| --- | --- |', '| Iris | 2 |',
    '', '```text', '<render literally>', '```', '', 'See [reference](https://example.org/reference).',
].join('\n')

async function render(parts: UIMessage['parts'], streaming = false) {
    await act(async () => root.render(<DesktopAssistantReply message={{ id: 'test-reply', role: 'assistant', parts }} streaming={streaming} />))
}

function mockClipboard() {
    const data = new DataTransfer()
    const command = vi.fn(() => {
        const event = new Event('copy', { cancelable: true })
        Object.defineProperty(event, 'clipboardData', { value: data })
        document.dispatchEvent(event)
        return event.defaultPrevented
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: command })
    return { command, data }
}

test('renders Markdown during a stream and in the settled reply; copy uses text parts only', async () => {
    await render([{ type: 'text', text: markdown.slice(0, markdown.indexOf('| Name')) }], true)
    expect(container.querySelector('ol')?.children).toHaveLength(2)
    expect(container.querySelector('button[aria-label="Copy reply"]')).toBeNull()
    const parts: UIMessage['parts'] = [
        { type: 'reasoning', text: 'Private trace never copied.' },
        { type: 'text', text: markdown.slice(0, markdown.indexOf('| Iris')) },
        { type: 'text', text: markdown.slice(markdown.indexOf('| Iris')) + ' Final sentence.' },
    ]
    await render(parts, true)
    expect(container.querySelector('h2')?.textContent).toBe('Desk notes')
    expect(container.querySelector('table td')?.textContent).toBe('Iris')
    await render(parts)
    expect(container.querySelector('pre')?.textContent).toContain('<render literally>')
    expect(container.querySelector('a')?.target).toBe('_blank')
    expect(container.querySelector('a')?.href).toBe('https://example.org/reference')
    expect(container.textContent).not.toContain('Private trace')
    const { data, command } = mockClipboard()
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy reply"]')!
    vi.stubGlobal('navigator', { userActivation: { isActive: false } })
    await act(async () => button.click())
    expect(command).not.toHaveBeenCalled()
    expect(button.textContent).toBe('Copy')
    vi.stubGlobal('navigator', { userActivation: { isActive: true } })
    await act(async () => button.click())
    expect(command.mock.calls).toEqual([['copy']])
    expect(data.getData('text/plain')).toBe(markdown + ' Final sentence.')
    expect(button.textContent).toBe('Copied')
})

test('copies each draft verbatim and keeps the whole reply and ordinary code separate', async () => {
    const body = '  To Mira,\n\n**Hello!** <img src="https://outside.invalid/pixel">\nGràcies.  '
    const first = 'Before.\n\n```draft Email to Mira\n' + body + '\n\n```\n\n'
    const next = '```draft\nSecond text\n```\n\n```js\nconst sample = 1\n```\n\nAfter.'
    const split = first.indexOf('Mira,')
    await render([
        { type: 'text', text: first.slice(0, split) },
        { type: 'text', text: first.slice(split) + next },
    ])
    const cards = container.querySelectorAll('[data-language="draft"]')
    expect(cards).toHaveLength(2)
    expect(cards[0].querySelector('[data-streamdown="code-block-header"] span')?.textContent).toBe('Email to Mira')
    expect(cards[1].querySelector('[data-streamdown="code-block-header"] span')?.textContent).toBe('Draft')
    expect(cards[0].querySelector('[data-streamdown="code-block-body"]')?.textContent).toBe(body)
    expect(cards[0].querySelector('strong,img')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toContain('const sample = 1')

    const { data, command } = mockClipboard()
    const button = cards[0].querySelector<HTMLButtonElement>('[aria-label="Copy draft"]')!
    vi.stubGlobal('navigator', { userActivation: { isActive: false } })
    await act(async () => button.click())
    expect(command).not.toHaveBeenCalled()
    vi.stubGlobal('navigator', { userActivation: { isActive: true } })
    await act(async () => button.click())
    expect(data.getData('text/plain')).toBe(body)
    expect(button.textContent).toBe('Copied')
    const second = cards[1].querySelector<HTMLButtonElement>('[aria-label="Copy draft"]')!
    expect(second.textContent).toBe('Copy')
    await act(async () => second.click())
    expect(data.getData('text/plain')).toBe('Second text')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Copy reply"]')!.click())
    expect(data.getData('text/plain')).toBe(first + next)
})

test('withholds draft copying until the closing fence arrives and excludes reasoning drafts', async () => {
    const summary = { type: 'reasoning' as const, text: '```draft\nSummary only\n```', providerMetadata: desktopSummaryMetadata }
    const draft = '```draft Letter\nWork in progress'
    await render([summary, { type: 'text', text: draft }], true)
    const draftCopy = () => container.querySelector<HTMLButtonElement>('[aria-label="Copy draft"]')!
    expect(draftCopy().disabled).toBe(true)
    const summaryButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Thought'))!
    await act(async () => summaryButton.click())
    expect(container.querySelector('pre')?.textContent).toContain('Summary only')
    expect(container.querySelectorAll('[aria-label="Copy draft"]')).toHaveLength(1)
    const { command } = mockClipboard()
    vi.stubGlobal('navigator', { userActivation: { isActive: true } })
    await act(async () => draftCopy().click())
    expect(command).not.toHaveBeenCalled()
    await render([summary, { type: 'text', text: draft + '\n```' }], true)
    expect(draftCopy().disabled).toBe(false)
    expect(container.querySelector('[aria-label="Copy reply"]')).toBeNull()
})

test('file, credentialed and relative links, model HTML and image URLs cannot load content or navigate', async () => {
    const unsafe = [
        '![descriptive alt](https://outside.invalid/pixel.png)',
        '[local](/desktop/settings) [data](data:text/plain,stuff) [password](https://user:secret@example.org/) [file](file:///tmp/foo)',
        '<iframe src="https://outside.invalid/frame"></iframe>',
        '<img src="https://outside.invalid/html.png">',
        '<script>alert(1)</script>',
    ].join('\n\n')
    await render([{ type: 'text', text: unsafe }])
    expect(container.textContent).toContain('descriptive alt')
    expect(container.textContent).toContain('password')
    expect(container.querySelector('img,iframe,script,object,embed,a')).toBeNull()
})

test('source parts use Rerun’s disclosure below the reply, with external URLs and inert document titles', async () => {
    const link = { type: 'source-url', sourceId: 'link-1', url: 'https://example.org/report', title: 'Quarterly report' } as const
    await render([{ type: 'text', text: 'Preliminary answer.' }, link], true)
    const trigger = container.querySelector<HTMLButtonElement>('button[data-slot="collapsible-trigger"]')!
    expect(trigger.textContent).toBe('Used 1 source')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('a[href]')).toBeNull()
    trigger.focus()
    expect(document.activeElement).toBe(trigger)
    await act(async () => trigger.click())
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    await render([
        link, { type: 'text', text: 'Settled answer.' }, link,
        { type: 'source-document', sourceId: 'doc-2', title: '', filename: 'notes.pdf', mediaType: 'application/pdf' },
    ])
    expect(trigger.textContent).toBe('Used 2 sources')
    const content = container.querySelector('[data-slot="collapsible-content"]')!
    const href = content.querySelector('a[href]')!
    expect(href.textContent).toBe('Quarterly report')
    expect(href.getAttribute('href')).toBe('https://example.org/report')
    expect(href.getAttribute('target')).toBe('_blank')
    expect(href.getAttribute('rel')).toBe('noopener noreferrer')
    expect(content.querySelectorAll('[href]')).toHaveLength(1)
    expect(content.textContent).toBe('Quarterly reportnotes.pdf')
    const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(before(container.querySelector('[data-bubble-frame]')!, trigger)).toBe(true)
    expect(before(content, container.querySelector('[aria-label="Copy reply"]')!)).toBe(true)
    await act(async () => trigger.click())
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

test('ordinary Markdown and unsafe source parts alone cannot produce a source disclosure', async () => {
    const urls = ['file:///tmp/notes.pdf', 'data:text/html,hello', '/desktop/settings', 'http://example.org', 'https://user:secret@example.org/']
    await render([
        { type: 'text', text: 'See [ordinary reference](https://example.org/read).' },
        ...urls.map((url, i) => ({ type: 'source-url' as const, sourceId: String(i), url, title: 'Unsafe source' })),
    ])
    expect(container.querySelector('[data-slot="collapsible-trigger"]')).toBeNull()
    expect(container.querySelectorAll('a[href]')).toHaveLength(1)
    expect(container.textContent).not.toContain('Unsafe source')
    expect(container.querySelector('img,iframe,script,object,embed')).toBeNull()
})

test('different steps can reuse a source ID and each step gets its own source limit', async () => {
    const first = Array.from({ length: 33 }, (_, index) => ({
        type: 'source-url' as const, sourceId: String(index), url: `https://example.org/first/${index}`,
    }))
    const next = { ...first[0], url: 'https://example.org/second' }
    await render([{ type: 'step-start' }, ...first, { type: 'step-start' }, next, next], true)
    const trigger = container.querySelector<HTMLButtonElement>('button[data-slot="collapsible-trigger"]')!
    expect(trigger.textContent).toBe('Used 33 sources')
    await act(async () => trigger.click())
    const urls = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href]'), a => a.href)
    expect(urls).toEqual([...first.slice(0, 32), next].map(source => source.url))
})
