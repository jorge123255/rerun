import { expect, test, vi } from 'vitest'
import { importedTemplateSetup, createTemplateAppRequirementProjection } from './requirements'
test('missing requirements produce unanswered setup without granting tools or carrying values', () => {
    const result = importedTemplateSetup({required:false,prompt:'Original instructions'},[{kind:'environment-key',name:'API_TOKEN'}])
    expect(result.required).toBe(true); expect(result.prompt).toContain('Original instructions'); expect(result.prompt).toContain('API_TOKEN')
    expect(result.prompt).toContain('no permission was enabled')
})
test('app projection reads only names at the exact local/engine owner boundary', async () => {
    const execute = vi.fn(async (_query: {args:unknown[];sql:string}) => ({rows:[{slug:'notion'},{slug:'notion'}]})), owner = vi.fn(async () => 'local-owner')
    const project = createTemplateAppRequirementProjection({ execute } as never, owner)
    expect(await project('engine-owner')).toEqual([{kind:'service-reconnect',name:'notion',detail:'Connect this app locally after installation.'}])
    expect(execute.mock.calls[0][0]).toMatchObject({args:['local-owner','engine-owner','removed']})
    expect(execute.mock.calls[0][0].sql).not.toContain('bearer')
})
