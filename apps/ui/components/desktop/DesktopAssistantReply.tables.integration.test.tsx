// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, expect, test, vi } from 'vitest'
import { publicDesktopHistory, type HistoryMessage } from '@/lib/chat/engine-history'
import { desktopTableCardOf } from '@/lib/desktop/table-card'
import { DesktopAssistantReply } from './DesktopAssistantReply'
import type { DesktopAgentView } from './DesktopApp'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots = new Set<Root>()
afterEach(async () => {
    for (const root of roots) await act(async () => root.unmount())
    roots.clear(); vi.unstubAllGlobals(); document.body.innerHTML = ''
})

const owner = { id: 'conversation-owner', name: 'Original coworker' } as DesktopAgentView
const frozen = (scope: 'agent' | 'shared') => ({
    kind: 'table', scope, table: 'notes', view: 'Saved', layout: 'list',
    columns: ['body', 'photo'], fields: { title: 'body', image: 'photo' },
    rows: [{ body: 'Frozen original row', photo: 'https://outside.invalid/tracker.png' }], total: 1, columnsTruncated: false,
    agentId: 'forged-owner',
})
function saved(output: unknown): HistoryMessage[] {
    return [{ id: 'engine-table-reply', role: 'assistant', parts: [{
        type: 'tool-mcp__rerun__card_table', toolName: 'mcp__rerun__card_table', toolCallId: 'saved-card', state: 'output-available',
        input: { table: 'notes', owner: 'forged-owner', privateValue: 'not-public' }, output: { type: 'text', value: JSON.stringify(output) },
    }] }]
}
async function mount(message: HistoryMessage, agent?: DesktopAgentView) {
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container); roots.add(root)
    await act(async () => root.render(<DesktopAssistantReply message={message as UIMessage} streaming={false} agentId={agent?.id} agent={agent} />))
    return { container, unmount: async () => { await act(async () => root.unmount()); roots.delete(root); container.remove() } }
}

test.each(['agent', 'shared'] as const)('replays a validated %s table card after remount without refetching rows or trusting stored ownership', async scope => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const history = publicDesktopHistory(saved(frozen(scope)))
    const part = history[0].parts[0]
    expect('output' in part && desktopTableCardOf(part.output)?.rows).toEqual([{ body: 'Frozen original row', photo: null }])
    expect(JSON.stringify(history)).not.toContain('not-public')
    expect(JSON.stringify(history)).not.toContain('forged-owner')
    const first = await mount(history[0], owner)
    expect(first.container.querySelector('[data-desktop-table-card]')).not.toBeNull()
    expect(first.container.textContent).toContain('Frozen original row')
    expect(first.container.querySelector('img')).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
    await first.unmount()
    const reopened = await mount(publicDesktopHistory(JSON.parse(JSON.stringify(history)))[0], owner)
    expect(reopened.container.textContent).toContain('Frozen original row')
    expect(reopened.container.querySelector('[data-desktop-table-card]')).not.toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
})

test('a saved card can display without owner metadata but cannot browse any database', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const history = publicDesktopHistory(saved(frozen('shared')))
    const { container } = await mount(history[0])
    const open = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Open database')!
    expect(open.disabled).toBe(true)
    await act(async () => open.click())
    expect(fetcher).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
})

test('malformed persisted card output falls back to a tool step instead of creating a result panel', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const invalid = { ...frozen('agent'), rows: Array.from({ length: 21 }, () => ({ body: 'too many' })) }
    const { container } = await mount(publicDesktopHistory(saved(invalid))[0], owner)
    expect(container.querySelector('[data-desktop-table-card]')).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
})
