// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { Conversation, ConversationContent } from '@/components/ai-elements/conversation'
import { DesktopConversationFind } from './DesktopConversationFind'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class TestHighlight extends Set<Range> {
    priority = 0
    constructor(...ranges: Range[]) { super(ranges) }
}

test('Find counts and highlights visible text in this transcript, across inline tokens', async () => {
    const highlights = new Map<string, TestHighlight>()
    vi.stubGlobal('Highlight', TestHighlight)
    vi.stubGlobal('CSS', Object.assign(Object.create(globalThis.CSS ?? null), { highlights }))
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    function Harness({ open, includeThird = false }: { open: boolean; includeThird?: boolean }) {
        const transcript = useRef<HTMLDivElement>(null)
        return <>
            <aside>Search cue on the board</aside>
            <Conversation><ConversationContent>
                <DesktopConversationFind open={open} onOpenChange={() => {}} transcript={transcript} />
                <div ref={transcript}>
                    <p>Search cue in a thread preview</p>
                    <div data-chat-find-message><p>Search <strong>cue</strong> in the first message</p></div>
                    <div data-chat-find-message>
                        <p>SEARCH CUE in the second message</p>
                        <p hidden>Search cue in hidden text</p>
                        <details><summary>Recorded action</summary><p>Search cue in a closed disclosure</p></details>
                        <p className="sr-only">Search cue in screen-reader UI chrome</p>
                        <p>Only this block</p><p>starts with text</p>
                    </div>
                    {includeThird && <div data-chat-find-message><p>Search cue from the newly streamed reply</p></div>}
                </div>
            </ConversationContent></Conversation>
        </>
    }
    const render = (open: boolean, includeThird = false) => act(async () => root.render(<Harness open={open} includeThird={includeThird} />))
    const type = (query: string) => act(async () => {
        const input = container.querySelector('input')!
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query)
        input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const status = () => container.querySelector('[role="status"]')?.textContent
    const found = () => [...(highlights.get('rerun-chat-find') ?? [])]
    const current = () => [...(highlights.get('rerun-chat-find-current') ?? [])][0]?.toString()
    const click = (label: string) => act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === label)!.click())
    try {
        await render(true)
        await type('search cue')
        expect(status()).toBe('1 of 2')
        expect(found().map(range => range.toString())).toEqual(['Search cue', 'SEARCH CUE'])
        expect(current()).toBe('Search cue')
        await click('Next')
        expect(status()).toBe('2 of 2')
        expect(current()).toBe('SEARCH CUE')
        await click('Next')
        expect(status()).toBe('1 of 2')
        await click('Previous')
        expect(status()).toBe('2 of 2')
        await render(true, true)
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 70)) })
        expect(status()).toBe('2 of 3')
        expect(found().map(range => range.toString())).toEqual(['Search cue', 'SEARCH CUE', 'Search cue'])
        await type('block starts')
        expect(status()).toBe('No matches')
        expect(found()).toEqual([])
        await type('search cue')
        await render(false)
        expect(highlights.size).toBe(0)
    } finally {
        await act(async () => root.unmount())
        container.remove()
        vi.unstubAllGlobals()
    }
})
