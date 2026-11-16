// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const orbs: { state: string; paused: boolean; size: number }[] = []
vi.mock('@rerun/ui/foreman', () => ({ Orb: (props: { state: string; paused: boolean; size: number }) => { orbs.push(props); return <i data-ball={props.state} data-ball-paused={String(props.paused)} /> } }))

import { DESKTOP_ORB_ACTIVITY, DesktopForemanOrb, DesktopForemanOrbStage, desktopOrbMood, type DesktopOrbMood } from './DesktopForemanOrb'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = ''; orbs.length = 0; vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function mount(node: ReactNode) {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    roots.push(root)
    await act(async () => { root.render(node) })
    return { host, render: (next: ReactNode) => act(async () => { root.render(next) }) }
}
const orb = (host: HTMLElement, role: string) => host.querySelector<HTMLElement>(`[data-foreman-orb-role="${role}"]`)!
const still = (element: HTMLElement) => element.hasAttribute('data-orb-still')

test('one mood at a time: the person recording or listening wins over the model, and waiting shows only at rest', () => {
    expect(desktopOrbMood({ activity: 'idle' })).toBe('idle')
    expect(desktopOrbMood({ activity: 'thinking' })).toBe('thinking')
    expect(desktopOrbMood({ activity: 'speaking' })).toBe('answering')
    expect(desktopOrbMood({ activity: 'idle', waiting: true })).toBe('waiting')
    expect(desktopOrbMood({ activity: 'thinking', waiting: true })).toBe('thinking')
    expect(desktopOrbMood({ activity: 'idle', reading: true, waiting: true })).toBe('reading')
    expect(desktopOrbMood({ activity: 'speaking', recording: true, reading: true })).toBe('recording')
    expect(DESKTOP_ORB_ACTIVITY).toEqual({ idle: 'idle', thinking: 'thinking', answering: 'speaking', recording: 'listening', reading: 'speaking', waiting: 'idle' })
})

test('the header orb shows each mood through the same aura, and the ball moves as upstream draws that state', async () => {
    const view = (mood: DesktopOrbMood) => <DesktopForemanOrbStage mood={mood}><DesktopForemanOrb role="header" size={30} /></DesktopForemanOrbStage>
    const { host, render } = await mount(view('idle'))
    const header = orb(host, 'header')
    expect(header.getAttribute('aria-hidden')).toBe('true')
    expect(header.querySelector('button')).toBeNull()
    expect([...header.children].map(child => child.className)).toEqual(['desktop-orb-aura', 'desktop-orb-ring', 'desktop-orb-body relative block'])
    for (const mood of ['idle', 'thinking', 'answering', 'recording', 'reading', 'waiting'] as const) {
        await render(view(mood))
        expect(header.dataset.orbMood).toBe(mood)
        expect(still(header)).toBe(false)
        expect(header.querySelector<HTMLElement>('[data-ball]')!.dataset.ball).toBe(DESKTOP_ORB_ACTIVITY[mood])
    }
})

test('one orb animates at a time: the large welcome orb leads while it is on screen and the header orb stands still', async () => {
    const view = (welcome: boolean) => <DesktopForemanOrbStage mood="thinking">
        <DesktopForemanOrb role="header" size={30} />
        {welcome && <DesktopForemanOrb role="welcome" size={72} />}
    </DesktopForemanOrbStage>
    const { host, render } = await mount(view(true))
    expect(still(orb(host, 'header'))).toBe(true)
    expect(orb(host, 'header').querySelector<HTMLElement>('[data-ball]')!.dataset.ballPaused).toBe('true')
    expect(still(orb(host, 'welcome'))).toBe(false)
    // Both read the one mood.
    expect(orb(host, 'welcome').dataset.orbMood).toBe('thinking')
    expect(orb(host, 'header').dataset.orbMood).toBe('thinking')
    await render(view(false))
    expect(still(orb(host, 'header'))).toBe(false)
    expect(orb(host, 'header').querySelector<HTMLElement>('[data-ball]')!.dataset.ballPaused).toBe('false')
})

test('nothing runs in a folded column or a hidden window', async () => {
    const view = (paused: boolean) => <DesktopForemanOrbStage mood="recording"><DesktopForemanOrb role="header" size={30} paused={paused} /></DesktopForemanOrbStage>
    const { host, render } = await mount(view(true))
    expect(still(orb(host, 'header'))).toBe(true)
    await render(view(false))
    expect(still(orb(host, 'header'))).toBe(false)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(still(orb(host, 'header'))).toBe(true)
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(still(orb(host, 'header'))).toBe(false)
})

test('an orb that leaves the screen stops', async () => {
    let report: (entries: { isIntersecting: boolean }[]) => void = () => {}
    vi.stubGlobal('IntersectionObserver', class { constructor(callback: typeof report) { report = callback } observe() {} disconnect() {} })
    const { host } = await mount(<DesktopForemanOrb role="welcome" size={72} mood="idle" />)
    expect(still(orb(host, 'welcome'))).toBe(false)
    await act(async () => { report([{ isIntersecting: false }]) })
    expect(still(orb(host, 'welcome'))).toBe(true)
})

test('outside a stage the orb reads what the panel says; an own mood overrides the stage', async () => {
    const { host } = await mount(<>
        <DesktopForemanOrb role="header" size={30} fallback="speaking" />
        <DesktopForemanOrbStage mood="waiting"><DesktopForemanOrb role="welcome" size={72} mood="thinking" activity="listening" /></DesktopForemanOrbStage>
    </>)
    expect(orb(host, 'header').dataset.orbMood).toBe('answering')
    expect(orb(host, 'welcome').dataset.orbMood).toBe('thinking')
    expect(orb(host, 'welcome').querySelector<HTMLElement>('[data-ball]')!.dataset.ball).toBe('listening')
})

test('every mood has its loop, a still orb has none, and Reduce motion leaves a still tint in place of movement', () => {
    const css = readFileSync(path.resolve(import.meta.dirname, '../../../app/desktop-panel-motion.css'), 'utf8')
    for (const mood of ['idle', 'thinking', 'answering', 'recording', 'reading', 'waiting']) expect(css).toContain(`[data-orb-mood='${mood}'] > .desktop-orb-aura { animation:`)
    // Waiting is a sparse nudge: the movement takes about a tenth of a six-second cycle.
    expect(css).toMatch(/\[data-orb-mood='waiting'\] > \.desktop-orb-body \{ animation: desktop-orb-nudge 6s/)
    expect(css).toMatch(/@keyframes desktop-orb-nudge \{\s*0%, 12%, 100% \{ transform: translateX\(0\) rotate\(0deg\); \}/)
    expect(css).toMatch(/\[data-orb-still\] > \.desktop-orb-aura,\s*\[data-orb-still\] > \.desktop-orb-ring,\s*\[data-orb-still\] > \.desktop-orb-body \{\s*animation: none;/)
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('animation: none !important;')
    expect(reduced).toMatch(/\[data-orb-mood\]:not\(\[data-orb-mood='idle'\]\):not\(\[data-orb-still\]\) > \.desktop-orb-aura \{\s*opacity: 0\.4;/)
    expect(css).toMatch(/\.desktop-orb-aura,\s*\.desktop-orb-ring \{[^}]*pointer-events: none;/)
})
