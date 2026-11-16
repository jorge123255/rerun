// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DESKTOP_ARRIVE_CLASS, DESKTOP_ARRIVE_TOP_CLASS, DESKTOP_SETTLE_CLASS, DesktopArrive, DesktopSettle, markDesktopArrivalSeen, resetDesktopArrivalsForTest, useDesktopLiveGate } from './DesktopArrive'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
beforeEach(() => { resetDesktopArrivalsForTest() })
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = ''; vi.useRealTimers() })

function mount() {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    roots.push(root)
    return { host, root }
}
const card = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-desktop-arrive]')!

test('a card that arrives live slides and fades in once, with its text in the page from the first frame', async () => {
    const { host, root } = mount()
    await act(async () => { root.render(<DesktopArrive id="approval:1" live><button type="button">Approve</button></DesktopArrive>) })
    expect(card(host).dataset.desktopArrive).toBe('live')
    for (const name of DESKTOP_ARRIVE_CLASS.split(' ')) expect(card(host).classList.contains(name)).toBe(true)
    // Nothing is held back or covered: the action is there and takes a click at once.
    expect(host.querySelector('button')!.textContent).toBe('Approve')
    expect(card(host).style.animationDelay).toBe('')
    expect(host.querySelector('[data-desktop-arrive-attention]')).toBeNull()
})

test('a card from a reopened conversation is simply there, and so is one mounted a second time', async () => {
    const first = mount()
    await act(async () => { first.root.render(<DesktopArrive id="question:1" live={false}>Saved</DesktopArrive>) })
    expect(card(first.host).dataset.desktopArrive).toBe('settled')
    expect(card(first.host).className).toBe('')
    // It was on screen once: scrolling back, another tab and back, or a parent that re-keys never replays it.
    const again = mount()
    await act(async () => { again.root.render(<DesktopArrive id="question:1" live>Saved</DesktopArrive>) })
    expect(card(again.host).dataset.desktopArrive).toBe('settled')

    const live = mount()
    await act(async () => { live.root.render(<DesktopArrive id="question:2" live>New</DesktopArrive>) })
    expect(card(live.host).dataset.desktopArrive).toBe('live')
    await act(async () => { live.root.render(null) })
    await act(async () => { live.root.render(<DesktopArrive id="question:2" live>New</DesktopArrive>) })
    expect(card(live.host).dataset.desktopArrive).toBe('settled')
})

test('what a view already held when it was opened can be marked, and then never plays', async () => {
    markDesktopArrivalSeen('connector:7')
    const { host, root } = mount()
    await act(async () => { root.render(<DesktopArrive id="connector:7" live attention>Held</DesktopArrive>) })
    expect(card(host).dataset.desktopArrive).toBe('settled')
    expect(host.querySelector('[data-desktop-arrive-attention]')).toBeNull()
})

test('a risky request gets one shake as it lands, a few arriving together are staggered, and the tag and attributes pass through', async () => {
    const { host, root } = mount()
    await act(async () => { root.render(<ul><DesktopArrive as="li" id="project:1" live attention delayMs={120} data-kind="project" aria-label="Project" className="rounded">Repo</DesktopArrive></ul>) })
    const item = card(host)
    expect(item.tagName).toBe('LI')
    expect(item.getAttribute('aria-label')).toBe('Project')
    expect(item.dataset.kind).toBe('project')
    expect(item.classList.contains('rounded')).toBe(true)
    expect(item.style.animationDelay).toBe('120ms')
    expect(item.classList.contains('fill-mode-backwards')).toBe(true)
    const shake = item.querySelector<HTMLElement>('[data-desktop-arrive-attention]')!
    expect(shake.className).toBe('desktop-attention-shake')
    expect(shake.textContent).toBe('Repo')
})

test('with Reduce motion on there is no movement: every arrival class switches the animation off, and the stylesheet stops the shake and the orb', () => {
    for (const classes of [DESKTOP_ARRIVE_CLASS, DESKTOP_ARRIVE_TOP_CLASS, DESKTOP_SETTLE_CLASS]) expect(classes.split(' ')).toContain('motion-reduce:animate-none')
    const css = readFileSync(path.resolve(import.meta.dirname, '../../../app/desktop-panel-motion.css'), 'utf8')
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.desktop-orb-aura,\s*\.desktop-orb-ring,\s*\.desktop-orb-body,\s*\.desktop-attention-shake\s*\{\s*animation: none !important;/)
    // The shake runs once, briefly; the loops animate transform and opacity only.
    expect(css).toMatch(/\.desktop-attention-shake\s*\{\s*animation: desktop-attention-shake 0\.36s ease-in-out 0\.32s 1;/)
    const frames = [...css.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\n\}/g)].map(match => match[1])
    expect(frames.length).toBeGreaterThan(5)
    for (const body of frames) for (const property of body.matchAll(/([a-z-]+):/g)) expect(['transform', 'opacity']).toContain(property[1])
    expect(readFileSync(path.resolve(import.meta.dirname, '../../../app/globals.css'), 'utf8')).toContain('@import "./desktop-panel-motion.css";')
})

function Gate({ scope, ready, onGate }: { scope: string; ready: boolean; onGate: (live: () => boolean) => void }) {
    onGate(useDesktopLiveGate(scope, ready, 400))
    return null
}

test('the gate stays shut while a conversation restores and for a moment after, opens for what comes later, and starts over on another conversation', async () => {
    vi.useFakeTimers()
    const { root } = mount()
    let live: () => boolean = () => true
    const render = (scope: string, ready: boolean) => act(async () => { root.render(<Gate scope={scope} ready={ready} onGate={gate => { live = gate }} />) })
    await render('chat-1', false)
    expect(live()).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(live()).toBe(false)
    // Restored: what it brought back is drawn in this very commit and just after it.
    await render('chat-1', true)
    expect(live()).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(399) })
    expect(live()).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(2) })
    expect(live()).toBe(true)
    await render('chat-2', true)
    expect(live()).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(401) })
    expect(live()).toBe(true)
    await render('chat-2', false)
    expect(live()).toBe(false)
})

function Settling() {
    const [answered, setAnswered] = useState(false)
    return <DesktopSettle stateKey={answered ? 'outcome' : 'actions'}>
        {answered ? <p>Approved</p> : <button type="button" onClick={() => setAnswered(true)}>Approve</button>}
    </DesktopSettle>
}

test('a resolved card fades its outcome in where its actions were; one that was already resolved when opened is still', async () => {
    const { host, root } = mount()
    await act(async () => { root.render(<Settling />) })
    const before = host.querySelector<HTMLElement>('[data-desktop-settle]')!
    expect(before.dataset.desktopSettle).toBe('still')
    expect(before.className).toBe('')
    await act(async () => { host.querySelector('button')!.click() })
    const after = host.querySelector<HTMLElement>('[data-desktop-settle]')!
    expect(after.dataset.desktopSettle).toBe('settled')
    expect(after.textContent).toBe('Approved')
    for (const name of DESKTOP_SETTLE_CLASS.split(' ')) expect(after.classList.contains(name)).toBe(true)

    const reopened = mount()
    await act(async () => { reopened.root.render(<DesktopSettle stateKey="outcome"><p>Approved</p></DesktopSettle>) })
    expect(reopened.host.querySelector<HTMLElement>('[data-desktop-settle]')!.dataset.desktopSettle).toBe('still')
})
