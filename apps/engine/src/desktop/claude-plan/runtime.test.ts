import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { desktopClaudeOutputFilter, desktopClaudeRuntime, desktopClaudeSpawnSpec } from './runtime'

const binary = '/app/resources/claude/claude', sandbox = '/app/resources/claude/runner.sb', profile = '/private/isolated/profile'
const options = () => ({ command: binary, args: ['--print', '--output-format', 'stream-json'], cwd: profile, env: { HOME: '/Users/person', NODE_OPTIONS: '--require=/private/evil.js', ANTHROPIC_API_KEY: 'ambient-key', CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'ambient-refresh', HTTPS_PROXY: 'http://attacker/' }, signal: new AbortController().signal })
describe('Claude process isolation', () => {
    it('uses only the bundled binary and isolated profile, ignoring ambient SDK environment', () => {
        const spec = desktopClaudeSpawnSpec(binary, sandbox, profile, 'account-access', { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', NODE_ENV: 'development' }, options())
        expect(spec.command).toBe('/usr/bin/sandbox-exec')
        expect(spec.args).toEqual(['-D', `PROFILE=${profile}`, '-D', `BINARY=${binary}`, '-f', sandbox, binary, ...options().args])
        expect(spec.env).toMatchObject({ NODE_ENV: 'production', HOME: profile, CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_OAUTH_TOKEN: 'account-access' })
        for (const forbidden of ['NODE_OPTIONS', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'HTTPS_PROXY']) expect(spec.env).not.toHaveProperty(forbidden)
    })
    it('reports missing bundled files without exposing their paths or creating a profile', () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'rerun-claude-unavailable-')))
        const runner = join(root, 'claude')
        const policy = join(root, 'runner.sb')
        try {
            vi.stubEnv('RERUN_DESKTOP_APP', '1')
            vi.stubEnv('RERUN_DESKTOP_CLAUDE_RUNNER', runner)
            vi.stubEnv('RERUN_DESKTOP_CLAUDE_SANDBOX', policy)
            vi.stubEnv('RERUN_DATA_DIR', join(root, 'data'))
            const start = () => desktopClaudeRuntime('mac-claude', 'synthetic-fixture', {})
            expect(start).toThrow(/^The bundled Claude runtime is unavailable\.$/)
            writeFileSync(runner, '')
            expect(start).toThrow(/^The bundled Claude runtime is unavailable\.$/)
            expect(existsSync(join(root, 'data'))).toBe(false)
        } finally {
            vi.unstubAllEnvs()
            rmSync(root, { recursive: true, force: true })
        }
    })
    it('refuses an ambient CLI, another cwd, permission bypass, and an aborted run', () => {
        for (const changed of [{ ...options(), command: '/usr/local/bin/claude' }, { ...options(), cwd: '/Users/person' }, { ...options(), args: ['--dangerously-skip-permissions'] }, { ...options(), signal: AbortSignal.abort() }]) expect(() => desktopClaudeSpawnSpec(binary, sandbox, profile, 'token', {}, changed)).toThrow()
    })
})


it('bounds protocol lines before parsing and redacts credential echoes split across chunks', async () => {
    const token = 'private-account-token', filter = desktopClaudeOutputFilter(token)
    const text = (async () => { let out = ''; for await (const part of filter) out += String(part); return out })()
    filter.write('{"text":"private-account-'); filter.end('token"}\n')
    expect(await text).toBe('{"text":"[redacted]"}\n')
    const bounded = desktopClaudeOutputFilter(token, 64, 8)
    const consume = (async () => { for await (const _part of bounded) { /* consume the guarded stream */ } })()
    bounded.end('0123456789')
    await expect(consume).rejects.toThrow('limit')
})
