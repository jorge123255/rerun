import { describe, expect, test } from 'vitest'
import {
    desktopSecretRequestDecisionSchema,
    desktopSecretRequestInputSchema,
    desktopSecretRequestViewSchema,
    parseDesktopSecretReceiptSummary,
    serializeDesktopSecretReceiptSummary,
} from '../../../../../../packages/contracts/src/desktop-secret-requests'

const fields = [{ key: 'EXAMPLE_API_KEY', label: 'Example API key', help: 'Create a test key.', docsUrl: 'https://example.com/keys' }]
const source = { agentId: 'agent', sessionId: 'chat', runId: 'run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'source-fingerprint' }

describe('canonical request input', () => {
    test('preserves ordered fields and short reason/help', () => {
        expect(desktopSecretRequestInputSchema.parse({ fields, reason: 'Use the example API.' })).toEqual({ fields, reason: 'Use the example API.' })
    })

    test.each(['RERUN_DESKTOP_RUNTIME_FILE', 'ENGINE_API_KEY', 'PATH', 'NODE_ENV'])('rejects reserved runtime key %s', key => {
        expect(desktopSecretRequestInputSchema.safeParse({ fields: [{ key, label: 'Runtime key' }] }).success).toBe(false)
    })

    test('rejects duplicate keys, non-HTTPS docs and invalid field counts', () => {
        expect(desktopSecretRequestInputSchema.safeParse({ fields: [...fields, fields[0]] }).success).toBe(false)
        expect(desktopSecretRequestInputSchema.safeParse({ fields: [{ ...fields[0], docsUrl: 'http://example.com' }] }).success).toBe(false)
        expect(desktopSecretRequestInputSchema.safeParse({ fields: [] }).success).toBe(false)
        expect(desktopSecretRequestInputSchema.safeParse({ fields: Array.from({ length: 9 }, (_, index) => ({ key: `KEY_${index}`, label: `Key ${index}` })) }).success).toBe(false)
    })
})

test('view contracts contain names and presence only, never submitted values', () => {
    const view = {
        requestId: 'request', revision: 'revision', source, fields: [{ ...fields[0], existing: true }], status: 'pending', createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
        receipt: { attemptId: 'attempt', decision: 'save', providedKeys: ['EXAMPLE_API_KEY'], skippedKeys: [], summary: 'Credential setup result', continuationRequestId: 'continuation', accepted: false, createdAt: '2026-11-05T00:00:00.000Z' },
    }
    expect(desktopSecretRequestViewSchema.parse(view)).toEqual(view)
    expect(desktopSecretRequestViewSchema.safeParse({ ...view, values: { EXAMPLE_API_KEY: 'dummy-secret' } }).success).toBe(false)
    expect(desktopSecretRequestViewSchema.safeParse({ ...view, fields: [{ ...fields[0], value: 'dummy-secret' }] }).success).toBe(false)
})

test('submit payload is the only contract that can carry exact credential strings', () => {
    const decision = { operation: 'save', requestId: 'request', attemptId: 'attempt', expectedRevision: 'revision', source, values: { EXAMPLE_API_KEY: '  exact bytes\r\n' } }
    expect(desktopSecretRequestDecisionSchema.parse(decision)).toEqual(decision)
})

test('names-only summary has no shell/MCP substitution promise and parses exactly', () => {
    const summary = serializeDesktopSecretReceiptSummary(fields, ['EXAMPLE_API_KEY'], 'save')
    expect(summary).toContain('- EXAMPLE_API_KEY: provided (stored encrypted for this coworker)')
    expect(summary).not.toContain('MCP server config')
    expect(summary).not.toContain('shell command')
    expect(summary).not.toContain('${KEY}')
    expect(parseDesktopSecretReceiptSummary(summary)).toEqual([{ key: 'EXAMPLE_API_KEY', provided: true }])
})
