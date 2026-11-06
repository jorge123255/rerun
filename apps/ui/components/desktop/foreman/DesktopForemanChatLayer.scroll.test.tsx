// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
