import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./auth', () => ({ authenticateDesktopEngineRequest: vi.fn() }))
vi.mock('./mcp-binding', () => ({ getDesktopRemoteMcpService: vi.fn() }))
import { desktopDocsAnswer, readDesktopDocsSections, resetDesktopDocsCache } from './docs-search'
import { parseDesktopForemanDocs } from './foreman-docs/search'

const EXPORT = '# Routines\nSource: https://docs.rerun.build/routines\n\nA routine runs a coworker on a schedule.\n\n# Vault\nSource: https://docs.rerun.build/vault\n\nThe Vault keeps app accounts.\n'
const live = async () => {}
beforeEach(() => resetDesktopDocsCache())

it('reads the export once an hour and serves the earlier copy when a refresh fails', async () => {
    const read = vi.fn(async () => ({ body: EXPORT, byteLength: EXPORT.length, version: 'v' }))
    const signal = new AbortController().signal
    const first = await readDesktopDocsSections(signal, live, 1_000, read)
    expect(first.stale).toBe(false)
    await readDesktopDocsSections(signal, live, 2_000, read)
    expect(read).toHaveBeenCalledTimes(1)
    read.mockRejectedValueOnce(new Error('offline'))
    const later = await readDesktopDocsSections(signal, live, 1_000 + 61 * 60_000, read)
    expect(later).toEqual({ sections: first.sections, stale: true })
})

it('fails when the export cannot be read and nothing was read before', async () => {
    await expect(readDesktopDocsSections(new AbortController().signal, live, 1_000, async () => { throw new Error('offline') })).rejects.toThrow('offline')
})

it('answers with passages and their links, or says nothing matched', () => {
    const sections = parseDesktopForemanDocs(EXPORT)
    const found = desktopDocsAnswer(sections, 'routine schedule', false)
    expect(found.status).toBe('ok')
    expect(found.passages[0]!.url).toContain('https://docs.rerun.build/')
    const none = desktopDocsAnswer(sections, 'zzzqqq', true)
    expect(none).toMatchObject({ status: 'empty', passages: [] })
    expect(none.note).toContain('never invent')
    expect(none.note).toContain('could not be refreshed')
})
