import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = realpathSync(mkdtempSync(resolve(tmpdir(), 'rerun-model-efforts-')))

const { afterEach, describe, expect, it, vi } = await import('vitest')
const { readFile, writeFile, mkdir } = await import('node:fs/promises')
const { connectionsDir } = await import('../config/paths.js')
const { chosenModelEffort, readModelEfforts, writeModelEffort } = await import('./model-efforts.js')
const { desktopClaudeEffort, desktopCodexEffort } = await import('../agents/reasoning.js')
const { DESKTOP_CODEX_ID } = await import('../desktop/codex-runtime.js')

type Run = Parameters<typeof desktopClaudeEffort>[0]
const run = (provider: string, id: string, model: string, config: Record<string, unknown> = {}) =>
    ({ provider, model, connection: { id, config: { provider, ...config } } }) as unknown as Run

afterEach(() => vi.unstubAllEnvs())

describe('the effort chosen for a model', () => {
    it('is saved per model, survives a reread of the file and is removed by null', async () => {
        expect(await readModelEfforts()).toEqual({})
        await writeModelEffort('mac-claude', 'claude-opus-5-5', 'high')
        await writeModelEffort(DESKTOP_CODEX_ID, 'gpt-6.1-sol', 'low')
        expect(JSON.parse(await readFile(resolve(connectionsDir(), 'model-efforts.json'), 'utf8'))).toEqual({ 'mac-claude::claude-opus-5-5': 'high', [`${DESKTOP_CODEX_ID}::gpt-6.1-sol`]: 'low' })
        expect(await chosenModelEffort('mac-claude', 'claude-opus-5-5', ['low', 'high'])).toBe('high')
        // An effort the model no longer offers is not sent.
        expect(await chosenModelEffort('mac-claude', 'claude-opus-5-5', ['low'])).toBeUndefined()
        expect(await chosenModelEffort('mac-claude', 'claude-sonnet-5-5', ['low', 'high'])).toBeUndefined()
        await writeModelEffort('mac-claude', 'claude-opus-5-5', null)
        expect(await readModelEfforts()).toEqual({ [`${DESKTOP_CODEX_ID}::gpt-6.1-sol`]: 'low' })
    })

    it('reaches a Claude run and wins over the model default on a ChatGPT run, on the Mac only', async () => {
        await mkdir(connectionsDir(), { recursive: true })
        await writeModelEffort('mac-claude', 'claude-opus-5-5', 'xhigh')
        const claude = run('claude', 'mac-claude', 'claude-opus-5-5')
        const codex = run('codex', DESKTOP_CODEX_ID, 'gpt-6.1-sol', { codexReasoning: { 'gpt-6.1-sol': { supported: ['low', 'medium', 'high'], default: 'medium' } } })
        expect(await desktopClaudeEffort(claude)).toBeUndefined()
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        expect(await desktopClaudeEffort(claude)).toBe('xhigh')
        // Nothing chosen for another Claude model: it keeps its own default.
        expect(await desktopClaudeEffort(run('claude', 'mac-claude', 'claude-sonnet-5-5'))).toBeUndefined()
        expect(await desktopCodexEffort(codex)).toBe('low')
        await writeModelEffort(DESKTOP_CODEX_ID, 'gpt-6.1-sol', null)
        expect(await desktopCodexEffort(codex)).toBe('medium')
    })
})
