// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'
import { loadMessages } from '@rerun/i18n/messages'
import { desktopMessages } from '@/lib/desktop/locale'
import { DesktopLocale } from '../DesktopLocale'
import { DesktopRoutineChecklistSteps, ROUTINE_STEPS_WITHIN_MS, routineStepDelayMs, type DesktopRoutineLastResult } from './DesktopRoutineStatus'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = '' })

const part = (number: number, status: 'done' | 'blocked' | 'skipped' | 'open', reason: string | null = null) => ({ number, text: `Part ${number}`, status, reason })
const result = (runId: string, parts: ReturnType<typeof part>[], extra: Record<string, unknown> = {}): DesktopRoutineLastResult =>
    ({ status: 'done', runId, outcome: { quiet: false, test: false, checklist: { reported: true, parts }, ...extra } }) as DesktopRoutineLastResult
const first = result('run-1', [part(1, 'done'), part(2, 'blocked', 'no access to the sheet'), part(3, 'skipped', 'already sent'), part(4, 'open')])

async function mount(initial: DesktopRoutineLastResult, locale: 'en' | 'fr' = 'en') {
    const messages = desktopMessages(locale, await loadMessages(locale))
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    roots.push(root)
    const render = (value: DesktopRoutineLastResult) => act(async () => { root.render(<DesktopLocale initial={{ preference: locale, locale, messages }}><DesktopRoutineChecklistSteps result={value} /></DesktopLocale>) })
    await render(initial)
    return { host, render }
}
const steps = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-routine-step]')]

test('opening the view on a finished run shows its steps already settled, each with its mark and reason', async () => {
    const { host } = await mount(first)
    const list = host.querySelector<HTMLElement>('[data-routine-checklist]')!
    expect(list.dataset.routineChecklist).toBe('settled')
    expect(list.getAttribute('aria-label')).toBe('What the last run did')
    expect(steps(host).map(step => [step.dataset.routineStep, step.textContent])).toEqual([
        ['done', 'DonePart 1'], ['blocked', 'BlockedPart 2 · no access to the sheet'], ['skipped', 'SkippedPart 3 · already sent'], ['open', 'Not reportedPart 4'],
    ])
    for (const step of steps(host)) { expect(step.className).not.toContain('animate-in'); expect(step.style.animationDelay).toBe('') }
})

test('a result that arrives while the view is open ticks its steps in one after another, 60 ms apart', async () => {
    const { host, render } = await mount(result('run-1', [part(1, 'open'), part(2, 'open')]))
    // The list is read again and brings the same result back: nothing moves.
    await render(result('run-1', [part(1, 'open'), part(2, 'open')]))
    expect(host.querySelector<HTMLElement>('[data-routine-checklist]')!.dataset.routineChecklist).toBe('settled')
    await render(result('run-2', [part(1, 'done'), part(2, 'blocked', 'the site was down'), part(3, 'skipped')]))
    expect(host.querySelector<HTMLElement>('[data-routine-checklist]')!.dataset.routineChecklist).toBe('live')
    expect(steps(host).map(step => step.style.animationDelay)).toEqual(['0ms', '60ms', '120ms'])
    for (const step of steps(host)) {
        expect(step.classList.contains('animate-in')).toBe(true)
        // Waiting for its turn, a step is not yet shown; with Reduce motion on all of them are there at once.
        expect(step.classList.contains('fill-mode-backwards')).toBe(true)
        expect(step.classList.contains('motion-reduce:animate-none')).toBe(true)
    }
    expect(steps(host).map(step => step.dataset.routineStep)).toEqual(['done', 'blocked', 'skipped'])
})

test('a first result arriving in an open view ticks in too', async () => {
    const { host, render } = await mount({ status: 'running', runId: 'run-9' })
    expect(host.querySelector('[data-routine-checklist]')).toBeNull()
    await render(result('run-9', [part(1, 'done')]))
    expect(host.querySelector<HTMLElement>('[data-routine-checklist]')!.dataset.routineChecklist).toBe('live')
})

test('however many steps there are, the last one lands within about a second', () => {
    expect([0, 1, 2].map(index => routineStepDelayMs(index, 3))).toEqual([0, 60, 120])
    expect(routineStepDelayMs(15, 16)).toBe(900)
    for (const count of [17, 40, 200]) expect(routineStepDelayMs(count - 1, count)).toBeLessThanOrEqual(ROUTINE_STEPS_WITHIN_MS)
    expect(routineStepDelayMs(39, 40)).toBe(975)
})

test('a quiet run, a run with no checklist and no result at all show no steps', async () => {
    const { host, render } = await mount(null)
    expect(host.textContent).toBe('')
    await render(result('run-3', [part(1, 'done')], { quiet: true }))
    expect(host.textContent).toBe('')
    await render({ status: 'done', runId: 'run-4', outcome: { quiet: false, test: false, checklist: { reported: false, parts: [part(1, 'open')] } } } as DesktopRoutineLastResult)
    expect(host.textContent).toBe('')
    await render({ status: 'done', runId: 'run-5', outcome: { quiet: false, test: true, checklist: null } } as DesktopRoutineLastResult)
    expect(host.textContent).toBe('')
})

test('the marks are said in the person\'s language', async () => {
    const { host } = await mount(first, 'fr')
    expect(steps(host).map(step => step.firstElementChild!.textContent)).toEqual(['Terminé', 'Bloqué', 'Ignoré', 'Non signalé'])
})
