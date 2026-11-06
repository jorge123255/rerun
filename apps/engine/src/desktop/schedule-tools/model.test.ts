import { describe, expect, it } from 'vitest'
import { DESKTOP_SCHEDULE_TOOL_MESSAGES as M } from '@rerun/contracts'
import { desktopScheduleModelDecision, isIanaTimezone } from './model.js'

describe('desktop schedule model decision', () => {
    const connected = { provider: 'openai', model: 'gpt-5' }

    it('accepts follow-coworker and a pin that matches the connected model', () => {
        expect(desktopScheduleModelDecision({ connected, loneProvider: 'ignore' })).toEqual({ ok: true })
        expect(desktopScheduleModelDecision({ provider: 'openai', model: 'gpt-5', connected, loneProvider: 'refuse' })).toEqual({ ok: true })
    })

    it('refuses a different pin instead of storing one the scheduler would ignore', () => {
        expect(desktopScheduleModelDecision({ provider: 'google', model: 'gemini-2.5-pro', connected, loneProvider: 'ignore' })).toEqual({ ok: false, refusal: M.pinIgnored('openai/gpt-5') })
        expect(desktopScheduleModelDecision({ model: 'gpt-5-mini', connected, loneProvider: 'ignore' })).toEqual({ ok: false, refusal: M.pinIgnored('openai/gpt-5') })
    })

    it('refuses a provider without a model only on update', () => {
        expect(desktopScheduleModelDecision({ provider: 'claude', connected, loneProvider: 'ignore' })).toEqual({ ok: true })
        expect(desktopScheduleModelDecision({ provider: 'claude', connected, loneProvider: 'refuse' })).toEqual({ ok: false, refusal: M.providerWithoutModel })
    })

    it('accepts UTC and refuses an invented timezone name', () => {
        expect(isIanaTimezone('Europe/Paris')).toBe(true)
        expect(isIanaTimezone('Not/AZone')).toBe(false)
    })
})
