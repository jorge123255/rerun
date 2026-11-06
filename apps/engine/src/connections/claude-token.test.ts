import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-claude-token-'))
process.env.RERUN_API_KEY = ''

const logged = vi.hoisted(() => [] as unknown[][])

vi.mock('../lib/logger.js', () => {
    const record = (level: string) => (...args: unknown[]) => {
        logged.push([level, ...args])
    }
    return { logger: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') } }
})

const { afterEach, beforeEach, describe, expect, it } = await import('vitest')
const { mkdir, rm } = await import('node:fs/promises')
const { connectionDir, connectionEnvPath } = await import('../config/paths.js')
const { readEnvFile, writeEnvFile } = await import('../lib/env-file.js')
const { acquireClaudeLease, claudeTokenOutlived, ensureFreshClaudeToken } = await import('./claude-token.js')
const { forgetCredentialRejected, isCredentialRejected, recordCredentialRejected } = await import('./credential-rejections.js')

const NOW = new Date('2026-09-30T12:00:00.000Z').getTime()
const SECRETS = ['old-access-token', 'old-refresh-token', 'new-access-token', 'new-refresh-token']
const realFetch = globalThis.fetch

let fetchMock: ReturnType<typeof vi.fn>

function answer(body: unknown, ok = true, status = ok ? 200 : 400) {
    fetchMock.mockImplementation(async () => ({ ok, status, json: async () => body }))
}

async function connection(env: Record<string, string>, id = 'claudecnx') {
    await rm(connectionDir(id), { recursive: true, force: true })
    await mkdir(connectionDir(id), { recursive: true })
    await writeEnvFile(connectionEnvPath(id), { ...env, UNRELATED: 'kept' })
    return { id, config: { name: 'Claude', provider: 'claude', models: [], extraModels: [], createdAt: '' }, env: { ...env } } as any
}

function expiring(minutesLeft: number) {
    return {
        CLAUDE_CODE_OAUTH_TOKEN: 'old-access-token',
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'old-refresh-token',
        CLAUDE_CODE_OAUTH_EXPIRES_AT: String(NOW + minutesLeft * 60_000),
    }
}

beforeEach(() => {
    logged.length = 0
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any
})

afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = realFetch
    for (const entry of logged) {
        const text = JSON.stringify(entry)
        for (const secret of SECRETS) expect(text).not.toContain(secret)
    }
})

describe('when no refresh is due', () => {
    it('skips a null connection', async () => {
        await ensureFreshClaudeToken(null)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('skips a static token with no refresh material', async () => {
        await ensureFreshClaudeToken(await connection({ CLAUDE_CODE_OAUTH_TOKEN: 'old-access-token', CLAUDE_CODE_OAUTH_EXPIRES_AT: String(NOW) }))
        await ensureFreshClaudeToken(await connection({ CLAUDE_CODE_OAUTH_TOKEN: 'old-access-token', CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'old-refresh-token' }))
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('skips an expiry it cannot read', async () => {
        await ensureFreshClaudeToken(await connection({ ...expiring(0), CLAUDE_CODE_OAUTH_EXPIRES_AT: 'soon' }))
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('skips a token with more than four hours left', async () => {
        await ensureFreshClaudeToken(await connection(expiring(4 * 60 + 1)))
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

describe('refreshing around the CLIs holding the token', () => {
    const fresh = { access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 28_800 }

    it('refreshes ahead of time while no CLI holds the token', async () => {
        answer(fresh)
        const cnx = await connection(expiring(3 * 60), 'idle-ahead')
        await ensureFreshClaudeToken(cnx)
        expect(cnx.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('new-access-token')
    })

    it('leaves the token alone while a CLI holds it, until the last minutes', async () => {
        answer(fresh)
        const cnx = await connection(expiring(3 * 60), 'leased')
        const release = acquireClaudeLease(cnx)

        await ensureFreshClaudeToken(cnx)
        expect(fetchMock).not.toHaveBeenCalled()

        cnx.env.CLAUDE_CODE_OAUTH_EXPIRES_AT = String(NOW + 4 * 60_000)
        await ensureFreshClaudeToken(cnx)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        release()
    })

    it('refreshes once the last CLI gives the token back, not before', async () => {
        answer(fresh)
        const cnx = await connection(expiring(3 * 60), 'released')
        const first = acquireClaudeLease(cnx)
        const second = acquireClaudeLease(cnx)

        first()
        first()
        await Promise.resolve()
        expect(fetchMock).not.toHaveBeenCalled()

        second()
        await vi.waitFor(() => expect(cnx.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('new-access-token'))
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('does not refresh on release when the token still has hours left', async () => {
        const cnx = await connection(expiring(5 * 60), 'released-early')
        acquireClaudeLease(cnx)()
        await Promise.resolve()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('waits before trying an ahead-of-time refresh again after a failure', async () => {
        const cnx = await connection(expiring(3 * 60), 'backoff')
        answer({ error: 'server_error' }, false, 400)
        await ensureFreshClaudeToken(cnx)
        await ensureFreshClaudeToken(cnx)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        forgetCredentialRejected(cnx.id)
    })
})

describe('whether a CLI token was outlived', () => {
    it('reads a replaced or lapsed token as outlived, the current one as not', async () => {
        const cnx = await connection(expiring(60), 'outlived')
        expect(claudeTokenOutlived(cnx, 'old-access-token')).toBe(false)
        expect(claudeTokenOutlived(cnx, 'older-access-token')).toBe(true)
        cnx.env.CLAUDE_CODE_OAUTH_EXPIRES_AT = String(NOW - 1)
        expect(claudeTokenOutlived(cnx, 'old-access-token')).toBe(true)
        expect(claudeTokenOutlived(null, 'old-access-token')).toBe(false)
        expect(claudeTokenOutlived(cnx, undefined)).toBe(false)
    })

    it('keeps a lapsed token the engine could not renew as a real sign-out', async () => {
        const cnx = await connection(expiring(60), 'outlived-rejected')
        cnx.env.CLAUDE_CODE_OAUTH_EXPIRES_AT = String(NOW - 1)
        recordCredentialRejected(cnx.id)
        expect(claudeTokenOutlived(cnx, 'old-access-token')).toBe(false)
        expect(claudeTokenOutlived(cnx, 'older-access-token')).toBe(true)
        forgetCredentialRejected(cnx.id)
    })
})

describe('refreshing', () => {
    it('posts the refresh token and rewrites .env and the shared object in place', async () => {
        answer({ access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 3600 })
        const cnx = await connection(expiring(4))

        await ensureFreshClaudeToken(cnx)

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0]!
        expect(url).toBe('https://platform.claude.com/v1/oauth/token')
        expect(JSON.parse(init.body)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'old-refresh-token' })

        const fresh = {
            CLAUDE_CODE_OAUTH_TOKEN: 'new-access-token',
            CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'new-refresh-token',
            CLAUDE_CODE_OAUTH_EXPIRES_AT: String(NOW + 3_600_000),
        }
        expect(await readEnvFile(connectionEnvPath(cnx.id))).toEqual({ ...fresh, UNRELATED: 'kept' })
        expect(cnx.env).toEqual(fresh)
    })

    it('refreshes a token that has already expired', async () => {
        answer({ access_token: 'new-access-token', expires_in: 60 })
        const cnx = await connection(expiring(-30))
        await ensureFreshClaudeToken(cnx)
        expect(cnx.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('new-access-token')
    })

    it('keeps the old refresh token when none comes back', async () => {
        answer({ access_token: 'new-access-token', expires_in: 60 })
        const cnx = await connection(expiring(1))
        await ensureFreshClaudeToken(cnx)
        expect(cnx.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBe('old-refresh-token')
        expect((await readEnvFile(connectionEnvPath(cnx.id))).CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBe('old-refresh-token')
    })

    it('drops the expiry when the response carries none', async () => {
        answer({ access_token: 'new-access-token', refresh_token: 'new-refresh-token' })
        const cnx = await connection(expiring(1))
        await ensureFreshClaudeToken(cnx)
        expect(cnx.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_EXPIRES_AT')
        expect(await readEnvFile(connectionEnvPath(cnx.id))).not.toHaveProperty('CLAUDE_CODE_OAUTH_EXPIRES_AT')
    })

    it('writes nothing on a rejected refresh or a response with no access token', async () => {
        const cnx = await connection(expiring(1))
        const before = await readEnvFile(connectionEnvPath(cnx.id))

        answer({ access_token: 'new-access-token' }, false, 401)
        await ensureFreshClaudeToken(cnx)
        answer({ refresh_token: 'new-refresh-token' })
        await ensureFreshClaudeToken(cnx)
        fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => Promise.reject(new Error('not json')) }))
        await ensureFreshClaudeToken(cnx)

        expect(fetchMock).toHaveBeenCalledTimes(3)
        expect(await readEnvFile(connectionEnvPath(cnx.id))).toEqual(before)
        expect(cnx.env).toEqual(expiring(1))
        const failures = logged.filter(([, , msg]) => msg === 'claude token refresh failed')
        expect(failures.map(([level]) => level)).toEqual(['error', 'warn', 'warn'])
    })

    it.each([
        ['a 400', 400, true],
        ['a 401', 401, true],
        ['a 503', 503, false],
    ])('flags the credential as rejected only when the refresh token is dead: %s', async (_label, status, rejected) => {
        vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout'] })
        const cnx = await connection(expiring(1), `rejected-${status}`)
        answer({ error: 'invalid_grant' }, false, status)
        const done = ensureFreshClaudeToken(cnx)
        await vi.advanceTimersByTimeAsync(5_000)
        await done
        expect(isCredentialRejected(cnx.id)).toBe(rejected)
        expect(fetchMock).toHaveBeenCalledTimes(rejected ? 1 : 3)
        forgetCredentialRejected(cnx.id)
    })

    it('clears the rejection once a refresh goes through', async () => {
        const cnx = await connection(expiring(1), 'rejected-then-ok')
        recordCredentialRejected(cnx.id)
        answer({ access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 3600 })
        await ensureFreshClaudeToken(cnx)
        expect(isCredentialRejected(cnx.id)).toBe(false)
    })

    it('tries a network failure twice more, then gives up quietly', async () => {
        vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout'] })
        fetchMock.mockRejectedValue(new Error('ECONNRESET'))
        const cnx = await connection(expiring(1), 'network-down')
        const done = ensureFreshClaudeToken(cnx)
        await vi.advanceTimersByTimeAsync(5_000)
        await expect(done).resolves.toBeUndefined()
        expect(fetchMock).toHaveBeenCalledTimes(3)
        expect(cnx.env).toEqual(expiring(1))
        expect(logged.some(([level, , msg]) => level === 'warn' && msg === 'claude token refresh skipped')).toBe(true)
    })

    it('goes through when the network comes back on a retry', async () => {
        vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout'] })
        fetchMock
            .mockRejectedValueOnce(new Error('fetch failed'))
            .mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'new-access-token', expires_in: 60 }) }))
        const cnx = await connection(expiring(1), 'network-flaky')
        const done = ensureFreshClaudeToken(cnx)
        await vi.advanceTimersByTimeAsync(1_000)
        await done
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(cnx.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('new-access-token')
    })

    it('shares one refresh between concurrent callers, then refreshes again once it settled', async () => {
        let release!: () => void
        fetchMock.mockImplementation(
            () =>
                new Promise(done => {
                    release = () => done({ ok: true, status: 200, json: async () => ({ access_token: 'new-access-token', expires_in: 60 }) })
                })
        )
        const cnx = await connection(expiring(1))

        const first = ensureFreshClaudeToken(cnx)
        const second = ensureFreshClaudeToken(cnx)
        await vi.waitFor(() => expect(release).toBeTypeOf('function'))
        release()
        await Promise.all([first, second])

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(cnx.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('new-access-token')

        cnx.env.CLAUDE_CODE_OAUTH_EXPIRES_AT = String(NOW)
        const third = ensureFreshClaudeToken(cnx)
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
        release()
        await third
    })
})

describe('refresh lineage after a replacement sign-in', () => {
    it.each([200, 401])('does not overwrite or reject the new credential after stale response %s', async status => {
        const cnx = await connection(expiring(0), `replaced-${status}`)
        let answerRefresh!: (response: unknown) => void, entered!: () => void
        const started = new Promise<void>(resolve => { entered = resolve })
        fetchMock.mockImplementation(() => { entered(); return new Promise(resolve => { answerRefresh = resolve }) })
        const pending = ensureFreshClaudeToken(cnx)
        await started
        await writeEnvFile(connectionEnvPath(cnx.id), { CLAUDE_CODE_OAUTH_TOKEN: 'replacement', CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'replacement-refresh' })
        answerRefresh({ ok: status === 200, status, json: async () => status === 200 ? { access_token: 'stale-refresh-result', refresh_token: 'stale-refresh-token' } : { error: 'invalid_grant' } })
        await pending
        expect((await readEnvFile(connectionEnvPath(cnx.id))).CLAUDE_CODE_OAUTH_TOKEN).toBe('replacement')
        expect(isCredentialRejected(cnx.id)).toBe(false)
    })
})
