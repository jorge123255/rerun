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
    it('returns the device code without waiting for a stalled provider snapshot', async () => {
        const readProviders = vi.fn(() => new Promise<never>(() => {}))
        const response = desktopCodexLoginBody(async () => waiting, readProviders)

        await Promise.resolve()

        expect(readProviders).not.toHaveBeenCalled()
        await expect(response).resolves.toEqual({ status: waiting, providers: null })
    })

    it('returns the provider snapshot when the account is connected', async () => {
        const status = { phase: 'connected' as const }
        const providers = { connections: [], default: null }
        const body = await desktopCodexLoginBody(async () => status, async () => providers)
        expect(body).toEqual({ status, providers })
    })

    it('keeps connected status when the provider snapshot fails', async () => {
        const status = { phase: 'connected' as const }
        const body = await desktopCodexLoginBody(async () => status, async () => { throw new Error('provider list unavailable') })
        expect(body).toEqual({ status, providers: null })
    })

    it('waits through Codex startup and device-code generation', () => {
        expect(DESKTOP_CODEX_LOGIN_BUDGET_MS).toBeGreaterThanOrEqual(150_000)
        const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal)
        expect(desktopCodexStartSignal()).toBe(timeout.mock.results[0]?.value)
        expect(timeout).toHaveBeenCalledWith(DESKTOP_CODEX_LOGIN_BUDGET_MS)
        timeout.mockRestore()
    })
})
