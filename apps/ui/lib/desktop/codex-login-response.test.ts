import { describe, expect, it, vi } from 'vitest'
import { DESKTOP_CODEX_LOGIN_BUDGET_MS, desktopCodexStartSignal } from './codex-login-budget'
import { desktopCodexLoginBody } from './codex-login-response'

const waiting = {
    phase: 'waiting' as const,
    userCode: 'TEST-CODE',
    verificationUrl: 'https://auth.openai.com/codex/device' as const,
    expiresAt: 1_700_000_000_000,
}

describe('desktop Codex sign-in response', () => {
    it('keeps a valid device code when the provider snapshot fails', async () => {
        const body = await desktopCodexLoginBody(async () => waiting, async () => { throw new Error('provider list unavailable') })
        expect(body).toEqual({ status: waiting, providers: null })
    })

    it('waits through Codex startup and device-code generation', () => {
        expect(DESKTOP_CODEX_LOGIN_BUDGET_MS).toBeGreaterThanOrEqual(150_000)
        const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal)
        expect(desktopCodexStartSignal()).toBe(timeout.mock.results[0]?.value)
        expect(timeout).toHaveBeenCalledWith(DESKTOP_CODEX_LOGIN_BUDGET_MS)
        timeout.mockRestore()
    })
})
