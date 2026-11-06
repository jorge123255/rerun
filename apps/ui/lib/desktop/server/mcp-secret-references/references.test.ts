import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
    desktopMcpRegistrationLink,
    desktopMcpSecretReferenceCanonical,
    desktopMcpSecretReferenceError,
    desktopMcpSecretReferenceIssue,
    desktopMcpSecretReferencePlan,
    desktopMcpSecretReferenceRedirectIssue,
    desktopMcpSecretReferenceReview,
    redactDesktopMcpSecretText,
    type DesktopMcpSecretBinding,
    type DesktopMcpSecretReferenceConfig,
} from '@rerun/contracts'
import { bindDesktopMcpSecretReferences } from './hooks'
import type { DesktopMcpSecretLookup } from './lookup'
import { linkDesktopMcpProposalCredentials } from './proposals'
import { type DesktopMcpResolvedMaterial, DesktopMcpSecretReferenceFailure, withDesktopMcpSecrets as resolveSecrets } from './resolve'

const withDesktopMcpSecrets = <T>(input: Omit<Parameters<typeof resolveSecrets<T>>[0], 'head' | 'check'>) => resolveSecrets({ ...input, head: { configRevision: '4', bindingRevision: 2, origin: 'app://desktop', fingerprint: createHash('sha256').update(desktopMcpSecretReferenceCanonical(input.config as DesktopMcpSecretReferenceConfig)).digest('hex') }, check: async () => {} })
const SECRET = 'linear-secret-value'
const secretBytes = () => new TextEncoder().encode(SECRET)

const config = (overrides: Partial<DesktopMcpSecretReferenceConfig> = {}): DesktopMcpSecretReferenceConfig => {
    const value: DesktopMcpSecretReferenceConfig = {
        name: 'linear',
        transport: 'http',
        args: [],
        url: 'https://mcp.example/mcp',
        env: {},
        headers: { Authorization: 'Bearer ${LINEAR_API_KEY}' },
        oauth: false,
        literalAuthorization: false,
        preservedLiteralKeys: [],
        ...overrides,
    }
    if (!value.url) delete value.url
    if (!value.command) delete value.command
    return value
}

const binding = (overrides: Partial<DesktopMcpSecretBinding> = {}): DesktopMcpSecretBinding => ({
    agentId: 'coworker',
    serverName: 'linear',
    configRevision: '4',
    bindingRevision: 2,
    field: 'header',
    fieldKey: 'Authorization',
    secretName: 'LINEAR_API_KEY',
    secretVersion: 3,
    status: 'bound',
    origin: 'app://desktop',
    ...overrides,
})

const owner = async (agentId: string) => agentId === 'coworker'
    ? { agentId, enabled: true, deleting: false, selfMcpGranted: true, localMcpStdioGranted: true }
    : null

function memoryLookup(rows: Record<string, { version: number; value: string }>): DesktopMcpSecretLookup {
    return {
        async version(agentId, key, gate) {
            await gate.check()
            if (agentId !== 'coworker') return { state: 'forbidden' }
            const row = rows[key]
            return row ? { state: 'present', version: row.version } : { state: 'missing' }
        },
        async open(agentId, key, expectedVersion, gate, invoke) {
            await gate.check()
            if (agentId !== 'coworker') return { state: 'forbidden' }
            const row = rows[key]
            if (!row) return { state: 'missing' }
            if (row.version !== expectedVersion) return { state: 'rotated', version: row.version }
            return { state: 'present', version: row.version, produced: await invoke(new TextEncoder().encode(row.value)) }
        },
    }
}

describe('desktop MCP secret references', () => {
    it('rejects unsupported placeholder forms instead of dropping them', () => {
        expect(desktopMcpSecretReferenceIssue(config({ headers: { Authorization: 'Bearer ${ONE} ${TWO}' } }))).toBe('Multiple ${NAME} placeholders in one value are not supported.')
        expect(desktopMcpSecretReferenceIssue(config({ url: 'https://mcp.example/${HOST}' }))).toBe('MCP server "linear" must not embed variable references in its url; put them in headers instead.')
        expect(desktopMcpSecretReferenceIssue(config({ transport: 'stdio', command: 'npx ${PACKAGE}', url: undefined, headers: {} }))).toBe('Command must not embed variable references.')
        expect(desktopMcpSecretReferenceIssue(config({ headers: { '${NOT_A_VAR}': 'x' } }))).toBe('Header "${NOT_A_VAR}" is not a valid HTTP header name.')
        expect(desktopMcpSecretReferenceIssue(config({ env: { '${NOT_A_VAR}': '${VALUE}' } }))).toBe('Environment variable "${NOT_A_VAR}" is not a valid variable name.')
        expect(desktopMcpSecretReferenceIssue(config({ args: ['prefix-${LINEAR_API_KEY}'] }))).toMatch(/must be exactly/)
        expect(desktopMcpSecretReferencePlan(config({ headers: { Authorization: 'Bearer ${ONE} ${TWO}' } }))).toBeNull()
    })

    it('keeps one credential authority and hides bearer bytes from review', () => {
        expect(desktopMcpSecretReferenceIssue(config({ oauth: true }))).toMatch(/credential authority/)
        const literal = config({ headers: { Authorization: 'Bearer mine-token-value' } })
        expect(desktopMcpSecretReferencePlan(literal)?.authority).toBe('literal')
        const review = desktopMcpSecretReferenceReview(literal)
        expect(review?.headerText).not.toContain('mine-token-value')
        expect(review?.notes).toContain('Bearer credential configured.')
        expect(desktopMcpSecretReferenceRedirectIssue('https://mcp.example/sse', 'https://evil.example/sse')).toMatch(/origin/)
        expect(desktopMcpSecretReferenceRedirectIssue('https://mcp.example/sse', 'https://mcp.example/messages?sessionId=abcdefghijklmnop')).toBeNull()
    })

    it('does not turn a missing reference into an empty string or a process environment value', async () => {
        const previousKey = process.env.RERUN_API_KEY
        const previousHub = process.env.RERUN_HUB_BASE_URL
        process.env.RERUN_API_KEY = 'engine-key'
        process.env.RERUN_HUB_BASE_URL = 'https://hub.example'
        const use = vi.fn()
        try {
            const admission = await withDesktopMcpSecrets({
                agentId: 'coworker',
                serverName: 'linear',
                phase: 'discovery',
                transport: 'http',
                config: config({ headers: { Authorization: 'Bearer ${RERUN_API_KEY}' } }),
                bindings: [binding({ secretName: 'RERUN_API_KEY', fieldKey: 'Authorization', status: 'pending', secretVersion: null })],
                authority: { currentOwner: owner },
                lookup: memoryLookup({}),
                use,
            })
            expect(admission.ok).toBe(false)
            if (!admission.ok) {
                expect(admission.code).toBe('pending')
                expect(admission.message).not.toBe('')
                expect(admission.message).not.toContain('engine-key')
                expect(admission.message).not.toContain('https://hub.example')
            }
            expect(use).not.toHaveBeenCalled()
        } finally {
            if (previousKey === undefined) delete process.env.RERUN_API_KEY
            else process.env.RERUN_API_KEY = previousKey
            if (previousHub === undefined) delete process.env.RERUN_HUB_BASE_URL
            else process.env.RERUN_HUB_BASE_URL = previousHub
        }
    })

    it('passes a literal Authorization through once and resolves a bound reference without inheriting the process environment', async () => {
        const previousPath = process.env.PATH
        process.env.PATH = '/usr/bin'
        const literalUse = vi.fn(async (_material: DesktopMcpResolvedMaterial) => 'connected')
        const literal = await withDesktopMcpSecrets({
            agentId: 'coworker',
            serverName: 'linear',
            phase: 'invocation',
            transport: 'http',
            config: config({ headers: { Authorization: 'Bearer mine-token-value', Accept: 'application/json' } }),
            bindings: [],
            authority: { currentOwner: owner },
            lookup: memoryLookup({}),
            use: literalUse,
        })
        expect(literal.ok).toBe(true)
        expect(literalUse).toHaveBeenCalledTimes(1)
        const literalHeaders = literalUse.mock.calls[0]![0].headers
        expect(literalHeaders).toEqual({ Authorization: 'Bearer mine-token-value', Accept: 'application/json' })
        expect(Object.keys(literalHeaders)).toEqual(['Authorization', 'Accept'])

        const resolvedUse = vi.fn(async (_material: DesktopMcpResolvedMaterial) => `echo ${SECRET}`)
        const resolved = await withDesktopMcpSecrets({
            agentId: 'coworker',
            serverName: 'files',
            phase: 'invocation',
            transport: 'stdio',
            config: config({ name: 'files', transport: 'stdio', command: 'server', url: undefined, headers: {}, env: { API_TOKEN: '${API_TOKEN}' }, args: ['--ok'] }),
            bindings: [binding({ serverName: 'files', field: 'env', fieldKey: 'API_TOKEN', secretName: 'API_TOKEN' })],
            authority: { currentOwner: owner },
            lookup: memoryLookup({ API_TOKEN: { version: 3, value: SECRET } }),
            use: resolvedUse,
        })
        expect(resolved.ok).toBe(true)
        if (resolved.ok) expect(resolved.value).toBe('echo [redacted]')
        expect(resolvedUse.mock.calls[0]![0]).toMatchObject({ inheritEnv: false, env: { API_TOKEN: SECRET }, args: ['--ok'], command: 'server' })
        expect(resolvedUse.mock.calls[0]![0].env.PATH).toBeUndefined()
        if (previousPath === undefined) delete process.env.PATH
        else process.env.PATH = previousPath
    })

    it('redacts raw and encoded echoes and drains a rotated binding once', async () => {
        const encoded = Buffer.from(SECRET).toString('base64')
        await expect(withDesktopMcpSecrets({
            agentId: 'coworker',
            serverName: 'linear',
            phase: 'discovery',
            transport: 'http',
            config: config(),
            bindings: [binding()],
            authority: { currentOwner: owner },
            lookup: memoryLookup({ LINEAR_API_KEY: { version: 3, value: SECRET } }),
            use: async () => { throw new Error(`rejected ${SECRET} ${encoded}`) },
        })).rejects.toThrow(DesktopMcpSecretReferenceFailure)
        await expect(withDesktopMcpSecrets({
            agentId: 'coworker',
            serverName: 'linear',
            phase: 'discovery',
            transport: 'http',
            config: config(),
            bindings: [binding()],
            authority: { currentOwner: owner },
            lookup: memoryLookup({ LINEAR_API_KEY: { version: 3, value: SECRET } }),
            use: async () => { throw new Error(`rejected ${SECRET} ${encoded}`) },
        })).rejects.toThrow(/\[redacted\]/)
        const failure = await withDesktopMcpSecrets({
            agentId: 'coworker',
            serverName: 'linear',
            phase: 'discovery',
            transport: 'http',
            config: config(),
            bindings: [binding()],
            authority: { currentOwner: owner },
            lookup: memoryLookup({ LINEAR_API_KEY: { version: 3, value: SECRET } }),
            use: async () => { throw new Error(`rejected ${SECRET} ${encoded}`) },
        }).catch(error => error as Error)
        if (!(failure instanceof Error)) throw new Error('Expected a redacted exception')
        expect(failure.message).not.toContain(SECRET)
        expect(failure.message).not.toContain(encoded)
        expect(redactDesktopMcpSecretText(encoded, [secretBytes()])).toBe('[redacted]')

        const mutated = vi.fn()
        const mutate = async <T>(_agent: string, _name: string, write: () => Promise<T>): Promise<T> => { mutated(); return write() }
        const disconnect = vi.fn()
        const markStale = vi.fn(async () => undefined)
        const hooks = bindDesktopMcpSecretReferences({
            lifecycle: { mutate, disconnect },
            lookup: memoryLookup({ LINEAR_API_KEY: { version: 9, value: SECRET } }),
            authority: { currentOwner: owner },
            records: { head: async () => ({ configRevision: '4', bindingRevision: 2, origin: 'app://desktop', fingerprint: createHash('sha256').update(desktopMcpSecretReferenceCanonical(config())).digest('hex'), authority: 'reference', publicJson: JSON.stringify(config()) }), bindings: async () => [binding()], serversForSecret: async () => ['linear'], markStale },
        })
        const use = vi.fn()
        const rotated = await hooks.beforeHttp({ agentId: 'coworker', serverName: 'linear', phase: 'discovery', config: config(), configRevision: '4', check: async () => {} }, use)
        expect(rotated.ok).toBe(false)
        if (!rotated.ok) expect(rotated.code).toBe('rotated')
        expect(mutated).toHaveBeenCalledTimes(1)
        expect(disconnect).not.toHaveBeenCalled()
        expect(use).not.toHaveBeenCalled()
        expect(markStale).toHaveBeenCalledWith('coworker', 'linear', 'LINEAR_API_KEY')
    })

    it('refuses a cross-owner binding and does not accept a proposal', async () => {
        const use = vi.fn()
        const forbidden = await withDesktopMcpSecrets({
            agentId: 'coworker',
            serverName: 'linear',
            phase: 'invocation',
            transport: 'http',
            config: config(),
            bindings: [binding({ agentId: 'other-coworker' })],
            authority: { currentOwner: owner },
            lookup: memoryLookup({ LINEAR_API_KEY: { version: 3, value: SECRET } }),
            use,
        })
        expect(forbidden.ok).toBe(false)
        if (!forbidden.ok) expect(forbidden.code).toBe('forbidden')
        expect(use).not.toHaveBeenCalled()
        const gate = { check() {} }
        const pending = await linkDesktopMcpProposalCredentials(config(), 'coworker', memoryLookup({}), gate)
        expect(pending.accepted).toBe(false)
        expect(pending.outcome).toBe('applied_pending_credentials')
        const ready = await linkDesktopMcpProposalCredentials(config(), 'coworker', memoryLookup({ LINEAR_API_KEY: { version: 3, value: SECRET } }), gate)
        expect(ready.accepted).toBe(false)
        expect(ready.outcome).toBe('credentials_ready')
        expect(desktopMcpRegistrationLink(config()).accepted).toBe(false)
        expect(desktopMcpSecretReferenceError('missing', 'LINEAR_API_KEY').message).not.toContain(SECRET)
        expect(createHash('sha256').update(desktopMcpSecretReferenceCanonical(config())).digest('hex')).toMatch(/^[a-f0-9]{64}$/)
    })
})
