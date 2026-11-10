// @vitest-environment happy-dom
import type { UIMessage } from 'ai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { publicDesktopHistory, type HistoryMessage } from '@/lib/chat/engine-history'
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

async function render(parts: UIMessage['parts'], streaming = false, agentId?: string) {
    await act(async () => root.render(<DesktopAssistantReply message={{ id: 'test-reply', role: 'assistant', parts }} streaming={streaming} agentId={agentId} />))
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

test('draws a live compaction step with the original wording and settles it in place', async () => {
    const running = { type: 'data-compaction' as const, id: 'checkpoint-1', data: { status: 'running' } }
    await render([running], true)
    expect(container.textContent).toContain('Compacting context…')
    expect(container.textContent).not.toContain('earlier messages summarized')

    const done = { type: 'data-compaction' as const, id: 'checkpoint-1', data: { status: 'done', messagesCompacted: 12, tokensRecovered: 900 } }
    await render([
        { type: 'reasoning', text: 'Compared the options.', providerMetadata: desktopSummaryMetadata },
        running,
        done,
        { type: 'text', text: 'Final answer.' },
    ])
    expect(container.textContent).toContain('Thought')
    expect(container.textContent).toContain('Compared the options.')
    expect(container.textContent).toContain('Context compacted')
    expect(container.textContent).toContain('12 earlier messages summarized')
    expect(container.textContent).toContain('~900 tokens recovered')
    expect(container.textContent).toContain('Final answer.')
    const settled = [...container.querySelectorAll('button')].filter(button => button.textContent?.includes('Context compacted'))
    expect(settled).toHaveLength(1)
    expect(container.textContent).not.toContain('Compacting context…')
})

test('an interrupted compaction leaves no unconfirmed row and keeps the rest of the reply', async () => {
    await render([
        { type: 'data-compaction' as const, id: 'checkpoint-1', data: { status: 'running' } },
        { type: 'text', text: 'Partial answer.' },
    ])
    expect(container.textContent).not.toContain('Compacting context…')
    expect(container.textContent).not.toContain('Context compaction failed')
    expect(container.textContent).not.toContain('Context compacted')
    expect(container.textContent).not.toContain('earlier messages summarized')
    expect(container.textContent).toContain('Partial answer.')
})

test('a received error event still shows the original failure wording', async () => {
    await render([
        { type: 'data-compaction' as const, id: 'checkpoint-1', data: { status: 'error' } },
        { type: 'text', text: 'Answer after a failed compaction.' },
    ])
    const failed = [...container.querySelectorAll('button')].filter(button => button.textContent?.includes('Context compaction failed'))
    expect(failed).toHaveLength(1)
    expect(container.textContent).not.toContain('Compacting context…')
    expect(container.textContent).toContain('Answer after a failed compaction.')
})

test('a completed compaction with invalid metrics keeps its wording without a count', async () => {
    await render([{ type: 'data-compaction' as const, id: 'checkpoint-1', data: { status: 'done', messagesCompacted: Number.NaN, tokensRecovered: -1 } }])
    expect(container.textContent).toContain('Context compacted')
    expect(container.textContent).not.toContain('earlier messages summarized')
    expect(container.textContent).not.toContain('tokens recovered')
})

test('a compaction row leaves reasoning, sources and feedback in place', async () => {
    const onRate = vi.fn()
    await act(async () => root.render(<DesktopAssistantReply message={{ id: 'engine-reply', role: 'assistant', parts: [
        { type: 'data-compaction', id: 'checkpoint-1', data: { status: 'done', messagesCompacted: 3 } },
        { type: 'reasoning', text: 'Kept thought.', providerMetadata: desktopSummaryMetadata },
        { type: 'text', text: 'Answer.' },
        { type: 'source-url', sourceId: 's1', url: 'https://example.org/report', title: 'Report' },
    ] }} streaming={false} feedbackRating="up" onRate={onRate} />))
    expect(container.textContent).toContain('Context compacted')
    expect(container.textContent).toContain('3 earlier messages summarized')
    expect(container.textContent).toContain('Thought')
    expect(container.textContent).toContain('Answer.')
    expect(container.textContent).toContain('Used 1 source')
    const up = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Good response'))!
    expect(up.getAttribute('aria-pressed')).toBe('true')
    await act(async () => up.click())
    expect(onRate).toHaveBeenCalledOnce()
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

test('rates a saved reply without changing whole-reply copy, and hides thumbs while a reply is still streaming', async () => {
    const onRate = vi.fn()
    await act(async () => root.render(<DesktopAssistantReply message={{ id: 'engine-saved', role: 'assistant', parts: [{ type: 'text', text: 'Shared answer' }] }} streaming onRate={onRate} />))
    expect(container.textContent).not.toContain('Good response')
    await act(async () => root.render(<DesktopAssistantReply message={{ id: 'live-reply', role: 'assistant', parts: [{ type: 'text', text: 'Shared answer' }] }} streaming={false} onRate={onRate} />))
    expect(container.textContent).not.toContain('Good response')
    await act(async () => root.render(<DesktopAssistantReply message={{ id: 'engine-saved', role: 'assistant', parts: [{ type: 'text', text: 'Shared answer' }] }} streaming={false} feedbackRating="up" onRate={onRate} />))
    const copy = container.querySelector<HTMLButtonElement>('[aria-label="Copy reply"]')!
    const up = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Good response'))!
    const down = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Bad response'))!
    expect(up.getAttribute('aria-pressed')).toBe('true')
    expect(down.getAttribute('aria-pressed')).toBe('false')
    expect(up.querySelector('svg')).not.toBeNull()
    const { command } = mockClipboard()
    vi.stubGlobal('navigator', { userActivation: { isActive: true } })
    await act(async () => copy.click())
    expect(command).toHaveBeenCalledWith('copy')
    expect(onRate).not.toHaveBeenCalled()
    await act(async () => down.click())
    expect(onRate).toHaveBeenCalledExactlyOnceWith('down')
    expect(container.textContent).not.toContain('Used')
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

test('shows a real read step on its reply, keeping literal file contents and errors separate from the answer', async () => {
    const base = { type: 'dynamic-tool' as const, toolName: 'mcp__rerun__fs_read', toolCallId: 'read-1', input: { path: 'notes/plan.md' } }
    const row = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.includes('Read File'))!
    await render([{ ...base, state: 'input-available' }], true)
    expect(row().textContent).toContain('notes/plan.md')
    await act(async () => row().click())
    expect(row().getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Input')
    expect(container.textContent).not.toContain('Output')
    for (const output of ['<b>file result</b>', { type: 'text', value: '<b>file result</b>' }]) {
        await render([{ ...base, state: 'output-available', output }, { type: 'text', text: 'My answer.' }])
        expect(container.textContent).toContain('Output<b>file result</b>')
        expect(container.querySelector('b')).toBeNull()
        expect(container.textContent).toContain('My answer.')
    }
    await render([{ ...base, state: 'output-error', errorText: 'Access denied.' }])
    expect(container.textContent).toContain('ErrorAccess denied.')
    await render([{ ...base, state: 'output-available', output: { type: 'error-text', value: 'Access denied.' } }])
    expect(container.textContent).toContain('ErrorAccess denied.')
    expect(container.textContent).not.toContain('Output')
    await render([{ ...base, state: 'output-available', output: { type: 'error-json', value: { message: 'Denied by host.' } } }])
    expect(container.textContent).toContain('ErrorDenied by host.')
    expect(container.textContent).not.toContain('Output')
    await render([{ type: 'text', text: 'I could use fs_read to answer.' }])
    expect(row()).toBeUndefined()
})

test('expands actual native steps with the same plain-text input and output across live and persisted parts', async () => {
    const part = { type: 'dynamic-tool' as const, toolName: 'exec', toolCallId: 'native-run',
        input: { type: 'commandExecution', command: 'printf test', cwd: '/private/profile' } }
    const output = { type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: '<b>sample</b>', _meta: 'engine-only' }
    await render([{ ...part, state: 'input-available' }], true)
    const button = Array.from(container.querySelectorAll('button')).find(el => el.textContent?.includes('Terminal'))!
    await act(async () => button.click())
    expect(container.textContent).toContain('printf test')
    for (const value of [output, { type: 'json', value: output }]) {
        await render([{ ...part, state: 'output-available', output: value }, { type: 'text', text: 'Final answer.' }])
        expect(container.textContent).toContain('Exit code 0\n<b>sample</b>')
        expect(container.textContent).not.toMatch(/engine-only|private\/profile/)
        expect(container.querySelector('b')).toBeNull()
    }
})

test('draws a Codex image result through the existing image card', async () => {
    const output = JSON.stringify({ kind: 'file', files: [{ path: 'generated-images/ig_1.png', name: 'ig_1.png', size: 70, scope: 'agent', identity: '12:34' }] })
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    await render([{ type: 'dynamic-tool', toolName: 'image_generation', toolCallId: 'image-1', state: 'output-available',
        input: { result: 'iVBORw0KGgo' }, output }], false, 'agent-1')
    await act(async () => { await Promise.all(fetchMock.mock.results.map(result => result.value)) })
    expect(container.querySelector('[data-file-card]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Open ig_1.png"]')).not.toBeNull()
    expect(container.textContent).not.toContain('iVBORw0KGgo')
    const called = fetchMock.mock.calls.map(call => String(call[0]))
    expect(called.some(url => url.includes('/files/image') && url.includes('generated-images') && url.includes('identity=12%3A34'))).toBe(true)
    expect(called.some(url => url.includes('/files/video'))).toBe(false)

    const blob = 'A'.repeat(400)
    await render([{ type: 'dynamic-tool', toolName: 'image_generation', toolCallId: 'image-raw', state: 'output-available',
        input: {}, output: blob }], false, 'agent-1')
    expect(container.querySelector('[data-file-card]')).toBeNull()
    expect(container.textContent).toContain('Image generation is not available.')
    expect(container.textContent).not.toContain(blob)
})

test('draws a recorded card_file result as file tiles instead of a generic tool step', async () => {
    const output = JSON.stringify({ kind: 'file', files: [{ path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent' }] })
    await render([{ type: 'dynamic-tool', toolName: 'mcp__rerun__card_file', toolCallId: 'card-1', state: 'output-available',
        input: { files: [{ path: 'reports/summary.md' }] }, output }], false, 'agent-1')
    const tile = container.querySelector<HTMLButtonElement>('button[aria-label="Open summary.md"]')
    expect(tile).not.toBeNull()
    expect(tile?.disabled).toBe(false)
    expect(container.querySelector('[data-file-card]')).not.toBeNull()
    expect(container.textContent).toContain('summary.md')
    expect(container.textContent).not.toContain('reports/summary.md')
    expect(container.textContent).not.toContain('Show a file')
})

test('shows the recorded file tiles but keeps them inert without a trusted coworker id', async () => {
    const output = JSON.stringify({ kind: 'file', files: [{ path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent' }] })
    await render([{ type: 'dynamic-tool', toolName: 'card_file', toolCallId: 'card-2', state: 'output-available',
        input: { files: [{ path: 'reports/summary.md' }] }, output }])
    const tile = container.querySelector<HTMLButtonElement>('button[aria-label="Open summary.md"]')
    expect(tile).not.toBeNull()
    expect(tile?.disabled).toBe(true)
    expect(container.querySelector('[data-file-card]')).not.toBeNull()
})

test('keeps an honest tool-result step for a malformed recorded file card', async () => {
    const output = JSON.stringify({ kind: 'file', files: [{ path: '../../escape.md', name: 'escape.md', size: 7, scope: 'agent' }] })
    await render([{ type: 'dynamic-tool', toolName: 'card_file', toolCallId: 'card-3', state: 'output-available',
        input: { files: [{ path: '../../escape.md' }] }, output }], false, 'agent-1')
    expect(container.querySelector('[data-file-card]')).toBeNull()
    const row = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Show a file'))!
    expect(row).not.toBeUndefined()
    await act(async () => row.click())
    expect(container.textContent).toContain('../../escape.md')
})

test('a restored generic receipt keeps its status and does not render a secret or foreign receipt metadata', async () => {
    const secret = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX'
    const password = 'hunter2secret'
    const forbidden = [secret, password, 'foreign-agent', 'foreign-workspace', 'foreign-run']
    const expectPrivate = () => {
        const html = container.innerHTML
        for (const token of forbidden) expect(html).not.toContain(token)
    }
    const show = async (id: string, parts: UIMessage['parts']) => {
        await act(async () => root.render(<DesktopAssistantReply message={{ id, role: 'assistant', parts }} streaming={false} agentId="agent-1" />))
    }

    await show('engine-foreign', [{
        type: 'dynamic-tool', toolName: 'fs_read', toolCallId: 'foreign-read', state: 'output-available',
        input: { path: `notes/${secret}.md`, preview: secret }, output: `seen ${secret}\npassword=${password} foreign-agent`,
        acknowledgement: 'lost', ownerId: 'foreign-agent', workspaceId: 'foreign-workspace', runId: 'foreign-run',
        providerMetadata: { desktop: { ownerId: 'foreign-agent', workspaceId: 'foreign-workspace', runId: 'foreign-run', token: secret, acknowledgement: 'lost' } },
    } as UIMessage['parts'][number]])
    expect(container.textContent).toContain('1 unknown')
    expect(container.querySelector('[data-historical="group"]')).not.toBeNull()
    expect(container.querySelector('[data-owner="foreign-agent"], [data-workspace="foreign-workspace"], [data-run="foreign-run"]')).toBeNull()
    expect(container.querySelector('[data-owner]')?.getAttribute('data-owner')).toBe('')
    expectPrivate()
    await act(async () => container.querySelector('button')!.click())
    expect(container.querySelector('[data-status="unknown"]')).not.toBeNull()
    expect(container.querySelector('[data-status="running"]')).toBeNull()
    expect(container.textContent).toContain('Unknown')
    expectPrivate()

    await show('engine-pending', [{
        type: 'dynamic-tool', toolName: 'fs_read', toolCallId: 'pending-read', state: 'approval-requested',
        input: { path: 'notes/plan.md' }, output: `seen ${secret} password=${password}`,
    } as unknown as UIMessage['parts'][number]])
    expect(container.textContent).toContain('1 pending')
    expect(container.querySelector('[data-historical="group"]')).not.toBeNull()
    await act(async () => container.querySelector('button')!.click())
    expect(container.querySelector('[data-status="pending"]')).not.toBeNull()
    expect(container.querySelector('[data-status="running"]')).toBeNull()
    expectPrivate()

    const cancelled = {
        type: 'tool-fs_read', toolName: 'fs_read', toolCallId: 'saved-read', state: 'output-available',
        input: { path: `notes/${secret}.md` }, output: `seen ${secret}\npassword=${password} foreign-agent`,
        acknowledgement: 'cancelled', ownerId: 'foreign-agent', workspaceId: 'foreign-workspace', runId: 'foreign-run',
        providerMetadata: { desktop: { token: secret, ownerId: 'foreign-agent', workspaceId: 'foreign-workspace', runId: 'foreign-run', acknowledgement: 'cancelled' } },
    }
    const [saved] = publicDesktopHistory([{ id: 'engine-saved', role: 'assistant', parts: [cancelled] as HistoryMessage['parts'] }])
    await show(saved.id, saved.parts as UIMessage['parts'])
    expect(container.textContent).toContain('1 cancelled')
    expect(container.querySelector('[data-owner="foreign-agent"]')).toBeNull()
    await act(async () => container.querySelector('button')!.click())
    expect(container.querySelector('[data-status="cancelled"]')).not.toBeNull()
    expect(container.querySelector('[data-status="running"]')).toBeNull()
    expect(container.querySelector('[data-owner="agent-1"]')).not.toBeNull()
    expectPrivate()

    const [failed] = publicDesktopHistory([{
        id: 'engine-failed', role: 'assistant',
        parts: [{
            type: 'tool-fs_read', toolName: 'fs_read', toolCallId: 'failed-read', state: 'output-available',
            input: { path: `notes/${secret}.md` }, output: { type: 'error-text', value: `Denied ${secret} password=${password}` },
            ownerId: 'foreign-agent', workspaceId: 'foreign-workspace', runId: 'foreign-run',
            providerMetadata: { desktop: { token: secret, ownerId: 'foreign-agent' } },
        }] as HistoryMessage['parts'],
    }])
    await show(failed.id, failed.parts as UIMessage['parts'])
    expect(container.textContent).toContain('Read File')
    expect(container.textContent).toContain('[redacted]')
    expect(container.querySelector('[data-historical="group"]')).toBeNull()
    expect(container.querySelector('[data-owner="foreign-agent"]')).toBeNull()
    await act(async () => container.querySelector('button')!.click())
    expect(container.textContent).toContain('Error')
    expect(container.textContent).toContain('notes/[redacted].md')
    expectPrivate()

    await show('engine-open', [{
        type: 'dynamic-tool', toolName: 'fs_read', toolCallId: 'open-read', state: 'input-available', input: { path: 'notes/plan.md' },
    }])
    expect(container.textContent).toContain('Read File')
    expect(container.textContent).toContain('notes/plan.md')
    expect(container.textContent).not.toContain('Unknown')
    expect(container.querySelector('[data-historical="group"]')).toBeNull()
})
