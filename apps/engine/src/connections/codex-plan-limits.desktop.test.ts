import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { DESKTOP_CODEX_ID, signedInFlag } from '../desktop/codex-runtime.js'
import { forgetPlanLimits, readPlanLimits, recordPlanLimits } from './plan-limits.js'
import { toSummary } from './loader.js'
import type { LoadedConnection } from './types.js'

const rpc = vi.hoisted(() => ({
    requests: [] as { method: string; params: object }[],
    account: { type: 'chatgpt' } as unknown,
    response: null as unknown,
    closeCount: 0,
}))

vi.mock('../desktop/codex-rpc.js', () => ({
    CodexAuthClient: class {
        async initialize() { await this.request('initialize', {}) }
        async request(method: string, params: object) {
            rpc.requests.push({ method, params })
            if (method === 'initialize') return {}
            if (method === 'account/read') return { account: rpc.account }
            if (method === 'account/rateLimits/read') return rpc.response
            throw new Error(`Unexpected synthetic request: ${method}`)
        }
        close() { rpc.closeCount += 1 }
    },
}))

import { refreshCodexPlanLimits } from './codex-plan-limits.js'

const fixture = {
    rateLimits: {
        primary: { usedPercent: 17, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: 63, windowDurationMins: 10080, resetsAt: null },
    },
}
const windows = [
    { kind: 'session', label: null, usedPercent: 17, resetsAt: null },
    { kind: 'weekly', label: null, usedPercent: 63, resetsAt: null },
]

function connection(patch: Partial<LoadedConnection> = {}): LoadedConnection {
    return {
        id: DESKTOP_CODEX_ID,
        config: { name: 'ChatGPT (Codex)', provider: 'codex', models: ['synthetic-model'], extraModels: [], createdAt: '2026-11-09T00:00:00.000Z' },
        env: { [signedInFlag]: '1' },
        ...patch,
    }
}

const DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-cx-desktop-plan-'))

beforeEach(() => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DATA_DIR', DATA_DIR)
    rpc.requests = []
    rpc.account = { type: 'chatgpt' }
    rpc.response = fixture
    rpc.closeCount = 0
})

afterEach(() => {
    vi.unstubAllEnvs()
    forgetPlanLimits(DESKTOP_CODEX_ID)
    forgetPlanLimits('another-connection')
})

test('a genuine-shaped desktop reading reaches only the authorized singleton summary', async () => {
    const current = connection()
    await refreshCodexPlanLimits(current)

    expect(rpc.requests.map(request => request.method)).toEqual(['initialize', 'account/read', 'account/rateLimits/read'])
    expect(rpc.requests[1]?.params).toEqual({ refreshToken: false })
    expect(rpc.closeCount).toBe(1)
    const reading = readPlanLimits(DESKTOP_CODEX_ID)
    expect(reading?.windows).toEqual(windows)
    expect(toSummary(current).planLimits).toEqual(reading)
    expect(readPlanLimits('another-connection')).toBeNull()
    expect(JSON.stringify(toSummary(current))).not.toContain(signedInFlag)
})

test('desktop refresh coalesces concurrent reads for the singleton', async () => {
    let resolveRead!: (value: unknown) => void
    rpc.response = new Promise(resolve => { resolveRead = resolve })
    const current = connection()

    const first = refreshCodexPlanLimits(current)
    const second = refreshCodexPlanLimits(current)
    expect(second).toBe(first)
    resolveRead(fixture)
    await Promise.all([first, second])

    expect(rpc.requests.filter(request => request.method === 'account/rateLimits/read')).toHaveLength(1)
    expect(readPlanLimits(DESKTOP_CODEX_ID)?.windows).toEqual(windows)
})

test('another identity or a disconnected singleton cannot collect usage', async () => {
    await refreshCodexPlanLimits(connection({ id: 'another-connection' }))
    await refreshCodexPlanLimits(connection({ env: {} }))

    expect(rpc.requests).toEqual([])
    expect(readPlanLimits(DESKTOP_CODEX_ID)).toBeNull()
    expect(readPlanLimits('another-connection')).toBeNull()
})

test('a non-ChatGPT account produces no rate-limit request or usage reading', async () => {
    rpc.account = null
    await refreshCodexPlanLimits(connection())

    expect(rpc.requests.map(request => request.method)).toEqual(['initialize', 'account/read'])
    expect(rpc.closeCount).toBe(1)
    expect(readPlanLimits(DESKTOP_CODEX_ID)).toBeNull()
})

test('an absent response retains the prior reading without manufacturing fresh values', async () => {
    recordPlanLimits(DESKTOP_CODEX_ID, [{ kind: 'session', label: null, usedPercent: 41, resetsAt: null }])
    const before = readPlanLimits(DESKTOP_CODEX_ID)
    rpc.response = null

    await refreshCodexPlanLimits(connection())

    expect(readPlanLimits(DESKTOP_CODEX_ID)).toBe(before)
    expect(readPlanLimits(DESKTOP_CODEX_ID)?.windows).toEqual([{ kind: 'session', label: null, usedPercent: 41, resetsAt: null }])
    expect(readPlanLimits('another-connection')).toBeNull()
})
