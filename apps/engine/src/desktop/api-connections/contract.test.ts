import { expect, it } from 'vitest'
import { desktopApiCanonicalJson, desktopApiConnectionViewSchema, desktopApiDefaultModelSchema } from '@rerun/contracts'

it('keeps redacted views strict and permits defaults from existing providers', () => {
    expect(desktopApiDefaultModelSchema.parse({ connectionId: 'mac-chatgpt', model: 'gpt-6-sol', reasoningEffort: 'high' })).toMatchObject({ connectionId: 'mac-chatgpt' })
    const view = {
        version: 1, workspaceId: 1, connectionId: 'cnx_fixture-00000001', revision: 'rev_fixture-00000001', provider: 'openai', name: 'OpenAI work', models: ['gpt-5'], extraModels: [], connected: true, credentialRejected: false, createdAt: '2026-11-06T00:00:00.000Z',
    }
    expect(desktopApiConnectionViewSchema.parse(view)).toEqual(view)
    expect(desktopApiConnectionViewSchema.safeParse({ ...view, env: { OPENAI_API_KEY: 'sk-secret' } }).success).toBe(false)
    expect(desktopApiConnectionViewSchema.safeParse({ ...view, secret: 'sk-secret' }).success).toBe(false)
})

it('canonicalizes fingerprints without changing array order', () => {
    expect(desktopApiCanonicalJson({ b: 2, a: { d: 4, c: 3 }, list: ['b', 'a'] })).toBe('{"a":{"c":3,"d":4},"b":2,"list":["b","a"]}')
})
