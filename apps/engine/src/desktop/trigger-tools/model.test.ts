import { describe, expect, it } from 'vitest'
import { DESKTOP_TRIGGER_TOOL_MESSAGES as M } from '@rerun/contracts'
import { desktopTriggerModelDecision } from './model.js'

describe('desktop trigger model decision', () => {
    const connected = { provider: 'openai', model: 'gpt-5' }

    it('follows the coworker when no pin is named', () => {
        expect(desktopTriggerModelDecision({ connected, loneProvider: 'ignore' })).toEqual({ ok: true, pins: 'omit' })
        expect(desktopTriggerModelDecision({ connected, loneProvider: 'refuse' })).toEqual({ ok: true, pins: 'omit' })
    })

    it('clears a pin that matches the connected model', () => {
        expect(desktopTriggerModelDecision({ provider: 'openai', model: 'gpt-5', connected, loneProvider: 'refuse' })).toEqual({ ok: true, pins: 'clear' })
    })

    it('refuses a different pin instead of storing one launch would resolve again', () => {
        expect(desktopTriggerModelDecision({ provider: 'google', model: 'gemini-2.5-pro', connected, loneProvider: 'ignore' })).toEqual({ ok: false, refusal: M.pinRefused('openai/gpt-5') })
        expect(desktopTriggerModelDecision({ model: 'gpt-5-mini', connected, loneProvider: 'ignore' })).toEqual({ ok: false, refusal: M.pinRefused('openai/gpt-5') })
    })

    it('refuses a named model when nothing is connected', () => {
        expect(desktopTriggerModelDecision({ model: 'gpt-5', connected: null, loneProvider: 'ignore' })).toEqual({ ok: false, refusal: M.noModel('gpt-5') })
    })

    it('ignores a lone provider on create and refuses it on update', () => {
        expect(desktopTriggerModelDecision({ provider: 'openai', connected, loneProvider: 'ignore' })).toEqual({ ok: true, pins: 'omit' })
        expect(desktopTriggerModelDecision({ provider: 'openai', connected, loneProvider: 'refuse' })).toEqual({ ok: false, refusal: M.providerWithoutModel })
    })
})
