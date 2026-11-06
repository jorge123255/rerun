import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { desktopMcpSecretReferenceCanonical, desktopMcpSecretReferencePublicConfig, type DesktopMcpSecretReferenceConfig } from '@rerun/contracts'
import { sameSecretReferenceOwner, secretReferenceEditorConfig, secretReferenceEditorSave, secretReferenceEditorSlot, secretReferenceFingerprint } from './editor-state'

const TOKEN = 'sk-live-example-token-value'
const base = (): DesktopMcpSecretReferenceConfig => ({
    name: 'linear',
    transport: 'http',
    args: ['--flag'],
    url: 'https://mcp.example/mcp',
    env: { LOG_LEVEL: 'info' },
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
    oauth: false,
    literalAuthorization: false,
    preservedLiteralKeys: [],
})

test('review save keeps the bearer requirement and omits the existing secret', async () => {
    const saved = await secretReferenceEditorSave({
        agentId: 'coworker',
        origin: 'app://desktop',
        saveId: 'save-1',
        expectedConfigRevision: '2',
        expectedBindingRevision: 0,
        base: base(),
        headersText: 'Accept=application/json\nX-Request=desk',
        envText: 'LOG_LEVEL=info',
        argsText: '--flag',
    })
    expect(JSON.stringify(saved)).not.toContain(TOKEN)
    expect(saved.config.literalAuthorization).toBe(true)
    expect(saved.config.preservedLiteralKeys).toEqual([{ field: 'header', key: 'Authorization' }])
    expect(saved.config.headers).toEqual({ Accept: 'application/json', 'X-Request': 'desk' })
    expect(saved.fingerprint).toBe(createHash('sha256').update(desktopMcpSecretReferenceCanonical(desktopMcpSecretReferencePublicConfig(saved.config)!)).digest('hex'))
    expect(saved.fingerprint).toBe(await secretReferenceFingerprint(desktopMcpSecretReferencePublicConfig(saved.config)!))
    expect(secretReferenceEditorSlot('coworker', 'linear')).toBe(secretReferenceEditorSlot('coworker', 'linear'))
    expect(secretReferenceEditorSlot('coworker', 'linear')).not.toBe(secretReferenceEditorSlot('other', 'linear'))
})

test('an inline secret is rejected without echoing it, and a recovery from another owner does not match', () => {
    expect(() => secretReferenceEditorConfig(base(), `Authorization=Bearer ${TOKEN}`, '', '')).toThrow(/\$\{NAME\}/)
    try {
        secretReferenceEditorConfig(base(), `Authorization=Bearer ${TOKEN}`, '', '')
    } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).not.toContain(TOKEN)
    }
    const attempt = {
        kind: 'save' as const,
        change: {
            saveId: 'save-1',
            agentId: 'coworker',
            serverName: 'linear',
            expectedConfigRevision: '0',
            expectedBindingRevision: 0,
            origin: 'app://desktop',
            fingerprint: 'a'.repeat(64),
            config: base(),
        },
    }
    expect(sameSecretReferenceOwner(attempt, 'coworker', 'linear')).toBe(true)
    expect(sameSecretReferenceOwner(attempt, 'other', 'linear')).toBe(false)
})
