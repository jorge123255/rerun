// @vitest-environment happy-dom
import type { UIMessage } from 'ai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
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
})
const markdown = [
    '## Desk notes', '', '1. First item', '2. Second item', '', '| Name | Count |', '| --- | --- |', '| Iris | 2 |',
    '', '```text', '<render literally>', '```', '', 'See [reference](https://example.org/reference).',
].join('\n')

async function render(parts: UIMessage['parts'], streaming = false) {
    await act(async () => root.render(<DesktopAssistantReply message={{ id: 'test-reply', role: 'assistant', parts }} streaming={streaming} />))
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
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy reply"]')!
    await act(async () => button.click())
    expect(write).toHaveBeenCalledWith(markdown + ' Final sentence.')
    expect(button.textContent).toBe('Copied')
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
