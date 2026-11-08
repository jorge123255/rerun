import { describe, expect, it } from 'vitest'
import { desktopClaudeOutputFilter, desktopClaudeSpawnSpec } from './runtime'

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
