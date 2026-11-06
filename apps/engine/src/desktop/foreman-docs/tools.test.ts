import { expect, it, vi } from 'vitest'
import { RERUN_PUBLIC_DOCS_CORPUS } from '@rerun/contracts'
import { desktopForemanDocsTools, type DesktopForemanDocsToolPorts } from './tools.js'

const binding = { workspaceId: '1', chatId: 'fmc_chat-0001', runId: 'run-1', model: { connectionId: 'conn-1', model: 'model-a' } }
const options = { messages: [], toolCallId: 'call-7' }
function ports(overrides: Partial<DesktopForemanDocsToolPorts> = {}) {
    return {
        binding,
        corpus: RERUN_PUBLIC_DOCS_CORPUS,
        assertCurrent: vi.fn(async () => {}),
        search: vi.fn(async () => ({ status: 'ok', documentation: RERUN_PUBLIC_DOCS_CORPUS.documentation, passages: [], source: null })),
        ...overrides,
    }
}

it('offers no documentation tool without an exact live binding and authorized adapter', () => {
    expect(desktopForemanDocsTools(ports({ binding: null }))).toEqual({})
    expect(desktopForemanDocsTools(ports({ search: null }))).toEqual({})
})

it('forwards the exact run, tool call, query and approved corpus around current-run checks', async () => {
    const value = ports()
    await desktopForemanDocsTools(value).search_docs!.execute!({ query: 'webhook token' }, options)
    expect(value.search).toHaveBeenCalledWith({ binding, toolCallId: 'call-7', query: 'webhook token', corpus: RERUN_PUBLIC_DOCS_CORPUS }, undefined)
    expect(value.assertCurrent).toHaveBeenCalledTimes(2)
})

it('does not publish a late tool completion after the run becomes historical', async () => {
    const value = ports({ assertCurrent: vi.fn(async () => {}).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('not live')) })
    await expect(desktopForemanDocsTools(value).search_docs!.execute!({ query: 'billing' }, options)).rejects.toThrow('not live')
})
