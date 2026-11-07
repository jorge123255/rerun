import { fileURLToPath } from 'node:url'
import { streamText } from 'ai'
import { createCodexAppServer } from 'ai-sdk-provider-codex-cli'
import { describe, expect, it } from 'vitest'

const fixture = (name: string) => fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url))

async function collectProviderErrors(codexPath: string): Promise<unknown[]> {
    const provider = createCodexAppServer({ defaultSettings: { codexPath, minCodexVersion: '0.144.0', logger: false } })
    const errors: unknown[] = []
    try {
        const result = streamText({ model: provider('gpt-5.6-sol'), prompt: 'hello', maxRetries: 0, abortSignal: AbortSignal.timeout(5_000), onError: ({ error }) => void errors.push(error) })
        for await (const part of result.fullStream) if (part.type === 'error') errors.push(part.error)
    } catch (error) {
        errors.push(error)
    } finally {
        await provider.close()
    }
    return errors
}

describe('codex app-server errors (upstream-compat)', () => {
    it('ends the run with the error when Codex reports a kind the provider does not list', async () => {
        const errors = await collectProviderErrors(fixture('fake-codex-app-server.mjs'))
        expect(String(errors[0] ?? '')).toContain('not supported when using Codex with a ChatGPT account')
    }, 15_000)

    it('ends the run when Codex reports a known object-shaped errorInfo', async () => {
        const errors = await collectProviderErrors(fixture('fake-codex-app-server-known-error.mjs'))
        expect(String(errors[0] ?? '')).toContain('HTTP connection failed')
    }, 15_000)

    it('surfaces an interrupted turn with unknown string errorInfo instead of hanging', async () => {
        const errors = await collectProviderErrors(fixture('fake-codex-app-server-interrupted.mjs'))
        expect(String(errors[0] ?? '')).toContain('Turn interrupted by an unknown Codex kind')
    }, 15_000)

    it('surfaces a malformed object-shaped unknown errorInfo instead of dropping the notification', async () => {
        const errors = await collectProviderErrors(fixture('fake-codex-app-server-malformed.mjs'))
        expect(String(errors[0] ?? '')).toContain('Malformed Codex error notification')
    }, 15_000)
})
