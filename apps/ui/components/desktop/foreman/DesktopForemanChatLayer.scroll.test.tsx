// @vitest-environment happy-dom
import { act, useState, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDesktopControlCenterKeys } from '@/lib/desktop/control-center'
import { DesktopForemanChatLayer } from './DesktopForemanChatLayer'

// Keep the real Conversation and use-stick-to-bottom implementation. Only the unrelated
// rich cards are replaced; geometry, observer delivery and animation frames are browser inputs.
vi.mock('./DesktopForemanWelcome', () => ({ DesktopForemanWelcome: () => null }))
vi.mock('./docs/DesktopForemanDocsTool', () => ({ DesktopForemanDocsTool: () => null }))
vi.mock('./plan/DesktopPlanCard', () => ({ DesktopPlanCard: () => null }))
vi.mock('./DesktopForemanBuildProgress', () => ({ DesktopForemanBuildProgress: () => null }))
vi.mock('./DesktopForemanNextSteps', () => ({ DesktopForemanNextSteps: () => null }))
vi.mock('motion/react', async () => {
    const { forwardRef } = await import('react')
    return {
        AnimatePresence: ({ children }: { children: ReactNode }) => children,
        motion: { div: forwardRef<HTMLDivElement, ComponentProps<'div'> & { initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown }>(function MotionDiv({ initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }, ref) { return <div {...props} ref={ref} /> }) },
    }
})

type Props = ComponentProps<typeof DesktopForemanChatLayer>
let root: Root | undefined
let host: HTMLDivElement
let frameId = 0
let frames: Map<number, FrameRequestCallback>
let observers: Set<GeometryObserver>

class GeometryObserver {
    targets = new Set<Element>()
    constructor(readonly callback: ResizeObserverCallback) { observers.add(this) }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear(); observers.delete(this) }
}

const saved = Array.from({ length: 12 }, (_, index) => ({ id: `saved-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const, text: `Saved message ${index}` }))
const defaults: Props = {
    messages: saved, restored: true, planSnapshot: null, decisionStatus: { status: 'idle' },
    build: null, nextSteps: [], leadState: { status: 'idle' }, live: false,
    onConfirmPlan() {}, onAskChanges() {}, onStartLead() {}, onOpenCreated() {},
}

async function render(props: Partial<Props> = {}) {
    await act(async () => root!.render(<DesktopForemanChatLayer {...defaults} {...props} />))
}

function geometry(height: number, viewport = 320) {
    const log = host.querySelector<HTMLElement>('[role="log"]')!
    expect(log).not.toBeNull()
    const scroll = log.firstElementChild as HTMLElement
    const content = scroll.firstElementChild as HTMLElement
    const size = { height, viewport }
    let top = 0
    scroll.style.overflow = 'auto'
    Object.defineProperties(scroll, {
        scrollHeight: { configurable: true, get: () => size.height },
        clientHeight: { configurable: true, get: () => size.viewport },
        scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, size.height - size.viewport)) } },
    })
    return {
        scroll,
        async resize(nextHeight: number, nextViewport = size.viewport) {
            size.height = nextHeight; size.viewport = nextViewport
            await act(async () => {
                for (const observer of observers) {
                    if (observer.targets.has(content)) observer.callback([{ target: content, contentRect: new DOMRectReadOnly(0, 0, 0, nextHeight), borderBoxSize: [{ inlineSize: 0, blockSize: nextHeight }], contentBoxSize: [{ inlineSize: 0, blockSize: nextHeight }], devicePixelContentBoxSize: [{ inlineSize: 0, blockSize: nextHeight }] }], observer as unknown as ResizeObserver)
                }
            })
        },
        bottom: () => Math.max(0, size.height - size.viewport),
    }
}

async function settle() {
    // The production spring runs on real rAF promises. Advance a bounded set of browser
    // frames, allowing each promise and React update to settle before the next frame.
    for (let index = 0; index < 160; index++) {
        await act(async () => {
            vi.advanceTimersByTime(16)
            const pending = [...frames.values()]; frames.clear()
            for (const callback of pending) callback(performance.now())
            await Promise.resolve()
        })
    }
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    frames = new Map(); observers = new Set(); frameId = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    vi.stubGlobal('ResizeObserver', GeometryObserver)
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
})

afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined; document.body.innerHTML = ''
    vi.useRealTimers(); vi.unstubAllGlobals()
})

it('places saved work after its own prompt even when two prompts have the same text', async () => {
    await render({
        messages: [
            { id: 'user-first', role: 'user', text: 'Same prompt', sourceRunId: 'run-first' },
            { id: 'answer-first', role: 'assistant', text: 'First answer' },
            { id: 'user-second', role: 'user', text: 'Same prompt', sourceRunId: 'run-second' },
            { id: 'answer-second', role: 'assistant', text: 'Second answer' },
        ],
        renderChildWork: slots => {
            const slot = slots.get('run-second')
            const card = <div>Second call completed</div>
            return slot ? createPortal(card, slot) : card
        },
    })
    expect(host.textContent).toMatch(/Same prompt.*First answer.*Same prompt.*Second call completed.*Second answer/)
    expect(host.textContent?.match(/Second call completed/g)).toHaveLength(1)
})

it('shortens safe sent links before and after history loads, preserving exact coworker mention styling and named Markdown links', async () => {
    const url = 'https://example.com/notes/prior/agenda?view=details'
    const withMention = `@Ada check ${url} then @Ada.`
    const plain = `Check ${url} or [the named reference](https://example.com/reference) [unsafe](https://user:pass@example.com/hidden)`
    const messages: Props['messages'] = [
        { id: 'with-mention', role: 'user', text: withMention, coworkerMentions: [{ targetId: 'ada', token: '@Ada', start: 0, end: 4 }],
            history: [{ kind: 'text', key: 'saved-mention', text: withMention }] },
        { id: 'plain', role: 'user', text: plain, history: [{ kind: 'text', key: 'saved-plain', text: plain }] },
    ]
    await render({ messages: messages.slice(0, 1), restored: false })
    expect(host.querySelector('a')?.getAttribute('href')).toBe(url)
    await render({ messages })
    const links = [...host.querySelectorAll('a')]
    expect(links.map(link => [link.textContent, link.getAttribute('href')])).toEqual([
        ['example.com/…/agenda…', url],
        ['example.com/…/agenda…', url],
        ['the named reference', 'https://example.com/reference'],
    ])
    expect(host.querySelectorAll('[class*="text-violet-700"]')).toHaveLength(1)
    expect(host.textContent).toContain('then @Ada.')
    expect(links.every(link => link.rel === 'noopener noreferrer')).toBe(true)
})

it('opens the latest restored message after an async history load and after reopening the dock', async () => {
    await render({ messages: [], restored: false })
    const view = geometry(120)
    await view.resize(120); await settle()
    await render()
    await view.resize(1600); await settle()
    expect(view.scroll.scrollTop).toBeGreaterThanOrEqual(view.bottom() - 2)
    expect(host.textContent).toContain('Saved message 11')

    await act(async () => root!.unmount())
    root = createRoot(host)
    await render()
    const reopened = geometry(1600)
    await reopened.resize(1600); await settle()
    expect(reopened.scroll.scrollTop).toBeGreaterThanOrEqual(reopened.bottom() - 2)
})

it('follows streamed text, later messages and dock reflow while already at the bottom', async () => {
    await render()
    const view = geometry(1000)
    await view.resize(1000); await settle()
    await render({ messages: [...saved, { id: 'reply', role: 'assistant', text: 'First tokens' }], streaming: true })
    await view.resize(1200); await settle()
    expect(view.scroll.scrollTop).toBeGreaterThanOrEqual(view.bottom() - 2)
    await render({ messages: [...saved, { id: 'reply', role: 'assistant', text: 'First tokens and the rest of the answer' }] })
    await view.resize(1450, 260); await settle()
    expect(view.scroll.scrollTop).toBeGreaterThanOrEqual(view.bottom() - 2)
})

it('keeps a reader in older history until they choose the original return-to-latest button', async () => {
    await render()
    const view = geometry(1400)
    await view.resize(1400); await settle()
    await act(async () => {
        view.scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
        view.scroll.scrollTop = 300
        view.scroll.dispatchEvent(new Event('scroll'))
        vi.advanceTimersByTime(2)
    })
    await render({ messages: [...saved, { id: 'later', role: 'assistant', text: 'A newer reply' }] })
    await view.resize(1800); await settle()
    expect(view.scroll.scrollTop).toBe(300)
    const latest = host.querySelector<HTMLButtonElement>('button[aria-label="Scroll to the latest message"]')
    expect(latest).not.toBeNull()
    await act(async () => latest!.click())
    await settle()
    expect(view.scroll.scrollTop).toBeGreaterThanOrEqual(view.bottom() - 2)
    await view.resize(2000); await settle()
    expect(view.scroll.scrollTop).toBeGreaterThanOrEqual(view.bottom() - 2)
})

it('routes Mac Find to the active Chief of Staff transcript and resets it when the chat changes', async () => {
    const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
    const messages: Props['messages'] = [
        { id: 'prompt', role: 'user', text: 'Status marker in my prompt' },
        { id: 'reply', role: 'assistant', text: 'Status marker in the reply', history: [
            { key: 'reply-text', kind: 'text', text: 'Status **marker** in the reply' },
            { key: 'reason', kind: 'reasoning', text: 'Status marker in reasoning' },
        ] },
    ]
    function Harness({ scope }: { scope?: string }) {
        const [centerOpen, setOpen] = useState(false)
        useDesktopControlCenterKeys({ open: centerOpen, setOpen, conversationOpen: false })
        return <>
            {centerOpen && <div role="dialog">Control Center</div>}
            <aside>Status marker on the board</aside>
            <div inert={centerOpen}>
                <DesktopForemanChatLayer {...defaults} messages={messages} findScope={scope} findHidden={centerOpen}
                    question={<button type="button">Status marker on a question</button>}
                    onCloseFind={() => host.querySelector('textarea')?.focus()} />
                <textarea aria-label="Chief of Staff composer" />
            </div>
        </>
    }
    const mount = (scope?: string) => act(async () => root!.render(<Harness scope={scope} />))
    const find = () => act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true })))
    const input = () => host.querySelector<HTMLInputElement>('input[aria-label="Find in conversation"]')
    try {
        await mount('chat-one')
        await find()
        expect(host.querySelector('[role="dialog"]')?.textContent).toBe('Control Center')
        expect(input()).toBeNull()
        await find()
        expect(host.querySelector('[role="dialog"]')).toBeNull()
        expect(document.activeElement).toBe(input())
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), 'status marker')
            input()!.dispatchEvent(new Event('input', { bubbles: true }))
        })
        expect(host.querySelector('[role="status"]')?.textContent).toBe('1 of 2')
        await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close find"]')!.click())
        expect(input()).toBeNull()
        expect(document.activeElement).toBe(host.querySelector('textarea'))
        await find()
        await find()
        expect(input()).not.toBeNull()
        await mount('chat-two')
        expect(input()).toBeNull()
        await mount()
        await find()
        await find()
        expect(input()).toBeNull()
    } finally {
        userAgent.mockRestore()
    }
})

it('renders the saved Chief of Staff decision as one read-only card and keeps ordinary text in history', async () => {
    const raw = 'Here are my approval decisions:'
    const messages: Props['messages'] = [
        { id: 'engine-request', role: 'assistant', text: 'Two suggested changes' },
        { id: 'engine-answer', role: 'user', text: raw, savedDecision: { kind: 'approvals', items: [
            { action: 'Review the draft', decision: 'approved' },
            { action: 'Rename the draft', decision: 'declined', note: 'Keep its name.' },
        ] } },
        { id: 'engine-paste', role: 'user', text: raw },
    ]
    await render({ messages })
    expect(host.textContent).toContain('Review the draft')
    expect(host.textContent).toContain('Approved')
    expect(host.textContent).toContain('Not now')
    expect(host.textContent).toContain('Keep its name.')
    expect(host.textContent?.split(raw)).toHaveLength(2)
    expect(Array.from(host.querySelectorAll('button')).some(button => /^(Approve|Decline)$/.test(button.textContent ?? ''))).toBe(false)
})
