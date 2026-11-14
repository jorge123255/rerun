// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { DesktopScheduleParser, DesktopScheduleSelection } from '@/lib/desktop/schedule-description'
import { DESKTOP_SCHEDULE_UNAVAILABLE, unavailableDesktopScheduleParser } from '@/lib/desktop/schedule-description'
import { DesktopScheduleDescription } from './DesktopScheduleDescription'

let root: Root
let container: HTMLDivElement
let onChange: Mock<(next: DesktopScheduleSelection) => void>
let parser: Mock<DesktopScheduleParser>

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-09T18:00:00Z'))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    onChange = vi.fn()
    parser = vi.fn(async () => ({ status: 'ok' as const, value: { mode: 'cron', cron: '0 8 * * 1-5', label: 'Weekdays at 8' } }))
    vi.stubGlobal('fetch', vi.fn())
})

afterEach(async () => {
    if (root) await act(async () => root.unmount())
    container.remove()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

async function render(options: { parser?: DesktopScheduleParser; timezone?: string } = {}) {
    await act(async () => root.render(<DesktopScheduleDescription
        mode="cron"
        cron="0 8 * * *"
        runAt=""
        timezone={options.timezone ?? 'America/Chicago'}
        agentId="alice"
        connectionId="conn-b"
        provider="openai"
        model="gpt-exact"
        onChange={onChange}
        parser={options.parser}
    />))
}

async function click(label: string) {
    const button = [...document.body.querySelectorAll('button')].find(node => node.textContent?.trim() === label)
    expect(button, `Missing button ${label}`).toBeDefined()
    await act(async () => { button!.click() })
}

async function enterDescription(text: string) {
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Describe the schedule"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    await act(async () => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}

async function preview(text = 'weekdays at 8') {
    await click('Describe schedule')
    await enterDescription(text)
    await click('Preview schedule')
}

describe('DesktopScheduleDescription', () => {
    it('previews with the exact editor timezone and mutates only on explicit confirmation', async () => {
        await render({ parser })
        await preview()

        expect(parser.mock.calls[0][0]).toMatchObject({ description: 'weekdays at 8', timezone: 'America/Chicago' })
        expect(onChange).not.toHaveBeenCalled()
        expect(document.body.textContent).toContain('Weekdays at 8')
        expect(document.body.textContent).toContain('0 8 * * 1-5')
        await click('Use schedule')
        expect(onChange).toHaveBeenCalledWith({ mode: 'cron', cron: '0 8 * * 1-5', runAt: null, timezone: 'America/Chicago' })
        expect(fetch).not.toHaveBeenCalled()
    })

    it('confirms a one-shot ISO value and preserves the current timezone when omitted', async () => {
        parser.mockResolvedValue({ status: 'ok', value: { mode: 'runAt', runAt: '2026-11-10T08:00:00-06:00' } })
        await render({ parser })
        await preview('tomorrow at 8')
        await click('Use schedule')

        expect(onChange).toHaveBeenCalledWith({ mode: 'runAt', cron: null, runAt: '2026-11-10T08:00:00-06:00', timezone: 'America/Chicago' })
    })

    it('requires a fresh preview after editing the schedule description', async () => {
        await render({ parser })
        await preview()
        await enterDescription('every day at 10')
        expect(document.body.textContent).not.toContain('Use schedule')
        expect(document.body.textContent).not.toContain('Weekdays at 8')
        expect(onChange).not.toHaveBeenCalled()

        parser.mockResolvedValue({ status: 'ok', value: { mode: 'cron', cron: '0 10 * * *', label: 'Daily at 10' } })
        await click('Preview schedule')
        expect(parser.mock.lastCall?.[0].description).toBe('every day at 10')
        await click('Use schedule')
        expect(onChange).toHaveBeenCalledExactlyOnceWith({ mode: 'cron', cron: '0 10 * * *', runAt: null, timezone: 'America/Chicago' })
    })

    it('requires a new preview when a one-shot time passes before confirmation', async () => {
        parser.mockResolvedValue({ status: 'ok', value: { mode: 'runAt', runAt: '2026-11-10T08:00:00-06:00' } })
        await render({ parser })
        await preview('tomorrow at 8')
        vi.setSystemTime(new Date('2026-11-10T14:00:00Z'))
        await click('Use schedule')

        expect(onChange).not.toHaveBeenCalled()
        expect(document.body.textContent).not.toContain('Use schedule')
        expect(document.body.textContent).toContain('This time has passed. Preview another time.')
    })

    it('shows explicit parse failure without changing the schedule', async () => {
        parser.mockResolvedValue({ status: 'invalid', message: 'Choose a clearer recurrence or one-shot time.' })
        await render({ parser })
        await preview('sometimes')

        expect(document.body.textContent).toContain('Choose a clearer recurrence or one-shot time.')
        expect(document.body.textContent).not.toContain('Use schedule')
        expect(onChange).not.toHaveBeenCalled()
    })

    it('rejects malformed successful output with the existing validation', async () => {
        parser.mockResolvedValue({ status: 'ok', value: { mode: 'cron', cron: 'not a cron' } })
        await render({ parser })
        await preview('whenever')

        expect(document.body.textContent).toContain('Could not understand that schedule')
        expect(document.body.textContent).not.toContain('Use schedule')
        expect(onChange).not.toHaveBeenCalled()
    })

    it('uses the truthful production unavailable state without a fake preview', async () => {
        await render({ parser: unavailableDesktopScheduleParser })
        await preview('every weekday')

        expect(document.body.textContent).toContain(DESKTOP_SCHEDULE_UNAVAILABLE)
        expect(document.body.textContent).not.toContain('Use schedule')
        expect(onChange).not.toHaveBeenCalled()
    })

    it('discards an unconfirmed preview on Cancel', async () => {
        await render({ parser })
        await preview()
        expect(document.body.textContent).toContain('Weekdays at 8')
        await click('Cancel')

        expect(onChange).not.toHaveBeenCalled()
        expect(document.body.textContent).not.toContain('Use schedule')
    })

    it('ignores a late parser response after unmount', async () => {
        let resolve!: (value: { status: 'ok'; value: { mode: 'cron'; cron: string; label: string } }) => void
        parser.mockReturnValue(new Promise(done => { resolve = done }))
        await render({ parser })
        await preview()
        await act(async () => root.unmount())
        resolve({ status: 'ok', value: { mode: 'cron', cron: '0 8 * * 1-5', label: 'Weekdays at 8' } })
        await act(async () => { await Promise.resolve() })

        expect(onChange).not.toHaveBeenCalled()
        expect(document.body.textContent).not.toContain('Weekdays at 8')
    })

    it('invalidates an unconfirmed preview when the editor timezone changes', async () => {
        await render({ parser })
        await preview()
        expect(document.body.textContent).toContain('Weekdays at 8')
        await act(async () => root.render(<DesktopScheduleDescription
            mode="cron" cron="0 8 * * *" runAt="" timezone="Europe/Paris" agentId="alice" connectionId="conn-b" provider="openai" model="gpt-exact" onChange={onChange} parser={parser}
        />))
        await click('Describe schedule')

        expect(document.body.textContent).not.toContain('Use schedule')
        expect(onChange).not.toHaveBeenCalled()
    })
})


describe('production parser binding', () => {
    it('uses the current routine selection through the local parser factory', async () => {
        const fetchMock = vi.mocked(fetch)
        fetchMock.mockResolvedValue(Response.json({ status: 'ok', value: { mode: 'cron', cron: '0 8 * * 1-5', label: 'Weekdays at 8' } }))
        await render()
        await preview()

        expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
            description: 'weekdays at 8', timezone: 'America/Chicago', connectionId: 'conn-b', provider: 'openai', model: 'gpt-exact',
        })
        await click('Use schedule')
        expect(onChange).toHaveBeenCalledWith({ mode: 'cron', cron: '0 8 * * 1-5', runAt: null, timezone: 'America/Chicago' })
    })
})
