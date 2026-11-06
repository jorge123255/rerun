import { describe, expect, it } from 'vitest'
import {
    SELF_MCP_GRANT,
    SELF_MCP_RESERVED_NAME,
    selfMcpCanonicalInput,
    selfMcpDecisionRequestSchema,
    selfMcpInputIssue,
    selfMcpProposalInput,
    selfMcpProposalSchema,
    selfMcpReceiptSchema,
    selfMcpResolvedTransport,
    selfMcpReviewSnapshotSchema,
    selfMcpRunIdentitySchema,
    type SelfMcpServerInput,
} from './desktop-self-mcp.js'

const identity = {
    engineAgentId: 'engine-alpha',
    sessionId: 'session-1',
    runId: 'run-1',
    toolCallId: 'call-1',
}

const valid = (overrides: Partial<SelfMcpServerInput> = {}): SelfMcpServerInput => ({
    name: 'linear',
    transport: 'http',
    command: undefined,
    args: [],
    url: 'https://mcp.linear.app',
    env: {},
    headers: { Authorization: 'Bearer ${LINEAR_API_KEY}' },
    ...overrides,
})

describe('selfMcpInputIssue — strict nonsecret proposal validation', () => {
    it('accepts a clean http server with placeholder headers', () => {
        expect(selfMcpInputIssue(valid())).toBeNull()
    })

    it('accepts a clean stdio server with placeholder env', () => {
        expect(selfMcpInputIssue(valid({ transport: 'stdio', command: 'npx', args: ['-y', '@server/files'], url: undefined, env: { API_KEY: '${KEY}' }, headers: {} }))).toBeNull()
    })

    it('rejects inline credentials in headers', () => {
        const issue = selfMcpInputIssue(valid({ headers: { Authorization: 'Bearer sk-ant-0123456789abcdef' } }))
        expect(issue).toMatch(/Header "Authorization" must be a fixed template with one \$\{NAME\} reference/)
    })

    it('rejects raw environment secrets', () => {
        expect(selfMcpInputIssue(valid({ transport: 'stdio', command: 'npx', url: undefined, env: { API_KEY: 'sk-ant-0123456789abcdef' }, headers: {} }))).toMatch(/never an inline secret/)
    })

    it('rejects env values that are not pure ${NAME} references', () => {
        expect(selfMcpInputIssue(valid({ transport: 'stdio', command: 'npx', url: undefined, env: { API_KEY: 'prefix-${KEY}' }, headers: {} }))).toMatch(/never an inline secret/)
    })

    it('rejects credential-bearing urls', () => {
        expect(selfMcpInputIssue(valid({ url: 'https://user:pass@mcp.example.com' }))).toMatch(/without credentials, query or fragment/)
        expect(selfMcpInputIssue(valid({ url: 'https://mcp.example.com/?token=abc' }))).toMatch(/without credentials, query or fragment/)
        expect(selfMcpInputIssue(valid({ url: 'https://mcp.example.com/#frag' }))).toMatch(/without credentials, query or fragment/)
    })

    it('rejects variable references embedded in a url', () => {
        expect(selfMcpInputIssue(valid({ url: 'https://mcp.example.com/${TOKEN}' }))).toMatch(/must not embed variable references in its url/)
    })

    it('rejects non-http(s) urls', () => {
        expect(selfMcpInputIssue(valid({ url: 'ftp://mcp.example.com' }))).toMatch(/Use an http\(s\) endpoint/)
    })

    it('rejects unrecognized fields at the typed-parse boundary (strict schema)', () => {
        const input = valid() as Record<string, unknown>
        input['unexpected'] = true
        // The hand-rolled issue check covers the nonsecret rules; the strict schema is what
        // refuses extras, so only the typed parse rejects the payload.
        expect(selfMcpInputIssue(input)).toBeNull()
        expect(selfMcpProposalInput(input)).toBeNull()
    })

    it('rejects invalid server names and the reserved bridge name', () => {
        expect(selfMcpInputIssue(valid({ name: 'bad name' }))).toMatch(/is invalid: use 1-64 characters/)
        expect(selfMcpInputIssue(valid({ name: 'x'.repeat(65) }))).toMatch(/is invalid: use 1-64 characters/)
        expect(selfMcpInputIssue(valid({ name: SELF_MCP_RESERVED_NAME }))).toMatch(/is reserved for the engine's own tools/)
    })

    it('rejects a server with no destination and an unsupported transport', () => {
        expect(selfMcpInputIssue(valid({ transport: 'stdio', command: undefined, url: undefined }))).toMatch(/needs a command/)
        expect(selfMcpInputIssue(valid({ transport: 'tcp', url: 'https://x.example' }))).toMatch(/Transport must be/)
    })

    it('rejects invalid env/header names and non-object env/headers', () => {
        expect(selfMcpInputIssue(valid({ transport: 'stdio', command: 'npx', url: undefined, env: { '1BAD': '${K}' }, headers: {} }))).toMatch(/not a valid variable name/)
        expect(selfMcpInputIssue(valid({ headers: { 'Bad\nHeader': '${K}' } }))).toMatch(/not a valid HTTP header name/)
        expect(selfMcpInputIssue({ ...valid(), env: 'API_KEY=${K}' })).toMatch(/Environment must be an object/)
        expect(selfMcpInputIssue({ ...valid(), headers: ['Authorization=Bearer ${K}'] })).toMatch(/Headers must be an object/)
    })

    it('rejects non-object input entirely', () => {
        expect(selfMcpInputIssue(null)).toMatch(/Provide an MCP server description/)
        expect(selfMcpInputIssue('nope')).toMatch(/Provide an MCP server description/)
    })
})

describe('selfMcpProposalInput — parses only valid candidates', () => {
    it('returns a typed input for a valid candidate and null for an invalid one', () => {
        const typed = selfMcpProposalInput(valid())
        expect(typed?.name).toBe('linear')
        expect(selfMcpProposalInput(valid({ headers: { Authorization: 'sk-live' } }))).toBeNull()
    })

    it('defaults args and normalizes an omitted transport', () => {
        const typed = selfMcpProposalInput({ name: 'linear', url: 'https://mcp.linear.app' })
        expect(typed?.args).toEqual([])
        expect(typed?.transport).toBeUndefined()
    })
})

describe('selfMcpResolvedTransport — mirrors the hosted resolver', () => {
    it('prefers an explicit transport', () => {
        expect(selfMcpResolvedTransport({ transport: 'http', command: 'npx', url: 'https://x.example' })).toBe('http')
    })

    it('auto-detects stdio from a command', () => {
        expect(selfMcpResolvedTransport({ command: 'npx' })).toBe('stdio')
    })

    it('auto-detects sse from an /sse url and http otherwise', () => {
        expect(selfMcpResolvedTransport({ url: 'https://x.example/sse' })).toBe('sse')
        expect(selfMcpResolvedTransport({ url: 'https://x.example/sse/' })).toBe('sse')
        expect(selfMcpResolvedTransport({ url: 'https://x.example/mcp' })).toBe('http')
    })

    it('defaults to stdio with no destination', () => {
        expect(selfMcpResolvedTransport({})).toBe('stdio')
    })
})

describe('selfMcpCanonicalInput — deterministic fingerprint source', () => {
    it('sorts env and header keys but preserves argument order', () => {
        const a = valid({ transport: 'stdio', command: 'npx', url: undefined, args: ['-y', 'z'], env: { B: '${B}', A: '${A}' }, headers: {} })
        const b = valid({ transport: 'stdio', command: 'npx', url: undefined, args: ['-y', 'z'], env: { A: '${A}', B: '${B}' }, headers: {} })
        expect(selfMcpCanonicalInput(a)).toBe(selfMcpCanonicalInput(b))
        const c = valid({ transport: 'stdio', command: 'npx', url: undefined, args: ['z', '-y'], env: {}, headers: {} })
        expect(selfMcpCanonicalInput(a)).not.toBe(selfMcpCanonicalInput(c))
    })

    it('is stable across runs', () => {
        const first = selfMcpCanonicalInput(valid())
        const second = selfMcpCanonicalInput(valid())
        expect(first).toBe(second)
        expect(JSON.parse(first)).toMatchObject({ name: 'linear', transport: 'http' })
    })
})

describe('contract schemas — strict canonical shapes', () => {
    it('validates run identity strictly', () => {
        expect(selfMcpRunIdentitySchema.parse(identity)).toEqual(identity)
        expect(selfMcpRunIdentitySchema.safeParse({ ...identity, extra: 1 }).success).toBe(false)
    })

    it('validates a decision request and refuses extra fields', () => {
        const request = {
            proposalId: 'prop-1',
            decisionId: 'dec-1',
            expectedProposalRevision: 1,
            expectedConfigRevision: 7,
            outcome: { kind: 'approved' },
        }
        expect(selfMcpDecisionRequestSchema.parse(request)).toEqual(request)
        expect(selfMcpDecisionRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false)
        expect(selfMcpDecisionRequestSchema.safeParse({ ...request, outcome: { kind: 'approved', note: 'x' } }).success).toBe(false)
    })

    it('validates a proposal and enforces fingerprint shape', () => {
        const fingerprint = 'a'.repeat(64)
        const proposal = {
            id: 'prop-1',
            revision: 1,
            agentId: 'local-1',
            identity,
            launchEpoch: 'epoch-1',
            fingerprint,
            input: valid(),
            transport: 'http',
            configRevision: 3,
            status: 'pending',
            createdAt: new Date().toISOString(),
        }
        expect(selfMcpProposalSchema.parse(proposal)).toEqual(proposal)
        expect(selfMcpProposalSchema.safeParse({ ...proposal, fingerprint: 'not-hex' }).success).toBe(false)
        expect(selfMcpProposalSchema.safeParse({ ...proposal, status: 'bogus' }).success).toBe(false)
        // The schema is deliberately permissive about header text; the strict nonsecret gate
        // (selfMcpInputIssue / selfMcpProposalInput) is what refuses inline secrets.
        expect(selfMcpProposalSchema.safeParse({ ...proposal, input: valid({ headers: { Authorization: 'sk-live' } }) }).success).toBe(true)
        expect(selfMcpProposalInput(valid({ headers: { Authorization: 'sk-live' } }))).toBeNull()
    })

    it('validates a receipt', () => {
        const receipt = {
            id: 'rc-1',
            proposalId: 'prop-1',
            decisionId: 'dec-1',
            outcome: 'applied',
            configRevision: 8,
            detail: 'Saved.',
            createdAt: new Date().toISOString(),
        }
        expect(selfMcpReceiptSchema.parse(receipt)).toEqual(receipt)
        expect(selfMcpReceiptSchema.safeParse({ ...receipt, outcome: 'applied_unverified' }).success).toBe(true)
        expect(selfMcpReceiptSchema.safeParse({ ...receipt, outcome: 'converged' }).success).toBe(false)
    })

    it('validates a review snapshot', () => {
        const fingerprint = 'b'.repeat(64)
        const snapshot = {
            proposal: {
                id: 'prop-1',
                revision: 1,
                agentId: 'local-1',
                identity,
                launchEpoch: 'epoch-1',
                fingerprint,
                input: valid(),
                transport: 'http',
                configRevision: 3,
                status: 'pending',
                createdAt: new Date().toISOString(),
            },
            configRevision: 3,
            connectivity: 'unverified',
            requirements: ['SSE transport is provided by a separate capability.'],
            conflict: { existing: true, managed: false, replaces: 'linear-old' },
            alreadyConfigured: false,
        }
        expect(selfMcpReviewSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    })

    it('exports the default-off grant id as a plain literal', () => {
        expect(SELF_MCP_GRANT).toBe('selfMcpRegister')
    })
})
