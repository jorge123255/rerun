// @vitest-environment jsdom
import { act, type ReactNode, type PointerEventHandler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DesktopForemanDockLayout } from './DesktopForemanDockLayout'
import { DEFAULT_FOREMAN_PLACEMENT } from '@/lib/foreman-layout'
import { DEFAULT_DOCK_EXTRAS } from '@/lib/desktop/foreman-dock/layout'

vi.mock('motion/react', async () => {
    const React = await import('react')
    const Div = React.forwardRef<HTMLDivElement, Record<string, unknown>>(({ children, layout: _layout, transition: _transition, initial: _initial, animate: _animate, exit: _exit, ...props }, ref) => <div {...props} ref={ref}>{children as ReactNode}</div>)
    return { motion: { div: Div }, AnimatePresence: ({ children }: { children: ReactNode }) => children, useReducedMotion: () => true }
})
let node: HTMLDivElement, root: Root
beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(() => { act(() => root.unmount()); node.remove() })
function pointer(target: EventTarget, type: string, x: number, y: number) {
    const event = new Event(type, { bubbles: true })
    Object.defineProperties(event, { pointerId: { value: 1 }, button: { value: 0 }, clientX: { value: x }, clientY: { value: y } })
    target.dispatchEvent(event)
}
function mount(extra: Partial<Parameters<typeof DesktopForemanDockLayout>[0]> = {}) {
    const props = { scope: 'workspace:chat', open: true, placement: DEFAULT_FOREMAN_PLACEMENT, dock: DEFAULT_DOCK_EXTRAS,
        onPlacement: vi.fn(), onDock: vi.fn(), onClose: vi.fn(), returnFocus: () => null as HTMLElement | null,
        children: (header: { onPointerDown: PointerEventHandler<HTMLElement> }) => <><header {...header}>Rerun</header><textarea defaultValue="unsent draft" /><button>Close</button></>, ...extra }
    act(() => root.render(<DesktopForemanDockLayout {...props} />))
    return props
}
it('interrupts a lifted drag on Escape without closing, saving, or changing the mounted board/draft', () => {
    const props = mount()
    const header = node.querySelector('header')!
    act(() => pointer(header, 'pointerdown', 100, 100))
    act(() => pointer(window, 'pointermove', 300, 300))
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    act(() => pointer(window, 'pointerup', 300, 300))
    expect(props.onPlacement).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(node.querySelector('textarea')?.value).toBe('unsent draft')
    expect(document.body.style.userSelect).toBe('')
})
it('treats a header click as a click, not a placement change', () => {
    const props = mount()
    act(() => pointer(node.querySelector('header')!, 'pointerdown', 100, 100))
    act(() => pointer(window, 'pointerup', 101, 101))
    expect(props.onPlacement).not.toHaveBeenCalled()
})
it('does not commit an interrupted resize or a release delivered after owner replacement', () => {
    const props = mount()
    act(() => pointer(node.querySelector('[role="separator"]')!, 'pointerdown', 500, 200))
    act(() => pointer(window, 'pointermove', 300, 200))
    act(() => root.render(<DesktopForemanDockLayout {...props} scope="other:chat" />))
    act(() => pointer(window, 'pointerup', 300, 200))
    expect(props.onPlacement).not.toHaveBeenCalled()
})
it('clamps restored floating geometry after resize without writing a new preference', () => {
    const props = mount({ placement: { ...DEFAULT_FOREMAN_PLACEMENT, mode: 'float', corner: 'bottom-right', width: 2000, height: 2000 } })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 320 })
    act(() => window.dispatchEvent(new Event('resize')))
    const panel = node.querySelector<HTMLElement>('[data-desktop-foreman-panel]')!
    expect(panel.style.width).toBe('100%')
    expect(parseFloat(panel.style.height)).toBeLessThan(320)
    expect(props.onPlacement).not.toHaveBeenCalled()
})
it('returns focus to the live parked trigger on deliberate close and keeps the draft mounted', () => {
    const trigger = document.createElement('button'); document.body.append(trigger)
    const props = mount({ returnFocus: () => trigger })
    act(() => root.render(<DesktopForemanDockLayout {...props} open={false} />))
    expect(document.activeElement).toBe(trigger)
    expect(node.querySelector('textarea')?.value).toBe('unsent draft')
    trigger.remove()
})
it('supports keyboard resizing and placement without registering a second global shortcut', () => {
    const props = mount()
    act(() => node.querySelector('[role="separator"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true })))
    expect(props.onPlacement).toHaveBeenCalledWith(expect.objectContaining({ mode: 'dock', side: 'left' }))
})
