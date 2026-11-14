import { expect, test, vi } from 'vitest'
import { importedTemplateSetup, readDesktopPortableSetupRequirements } from './requirements'
test('missing requirements produce unanswered setup without granting tools or carrying values', () => {
    const result = importedTemplateSetup({required:false,prompt:'Original instructions'},[{kind:'environment-key',name:'API_TOKEN'}])
    expect(result.required).toBe(true); expect(result.prompt).toContain('Original instructions'); expect(result.prompt).toContain('API_TOKEN')
    expect(result.prompt).toContain('no permission was enabled')
})
test('portable setup projects names only and rejects values disguised as names', async () => {
    const execute = vi.fn<(_query: { args: unknown[]; sql: string }) => Promise<{ rows: { kind: string; name: string }[] }>>(async () => ({
        rows: [{ kind: 'environment-key', name: 'TEAM_KEY' }, { kind: 'service-reconnect', name: 'notion' }],
    }))
    const owner = { id: 'local-owner', engineAgentId: 'engine-owner' }
    const db = { execute } as never
    expect(await readDesktopPortableSetupRequirements(db, owner)).toEqual([
        { kind: 'environment-key', name: 'TEAM_KEY', detail: 'Provide this value locally after installation.' },
        { kind: 'service-reconnect', name: 'notion', detail: 'Connect this app locally after installation.' },
    ])
    expect(execute.mock.calls[0][0].args).toEqual(['local-owner', 'engine-owner', 'local-owner', 'local-owner'])
    execute.mockResolvedValueOnce({ rows: [{ kind: 'service-reconnect', name: 'https://account.example/token' }] })
    await expect(readDesktopPortableSetupRequirements(db, owner)).rejects.toMatchObject({ status: 409 })
})
