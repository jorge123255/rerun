// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { resolveDesktopConnectorTool } from './connector-apps'
import { invalidateDesktopConnectorApps, resetDesktopConnectorAppsForTest, useDesktopConnectorApps } from './use-connector-apps'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const listing = (agentId: string) => ({ agentId, servers: [{ server: 'linear', slug: 'linear', name: 'Linear', icon: '/services/linear.svg', category: 'productivity' }], toolkits: [] })
let calls: string[] = []
let answer: (url: string) => Response | Promise<Response>
beforeEach(() => {
    calls = []
    answer = url => Response.json(listing(decodeURIComponent(url.split('/')[4]!)))
    resetDesktopConnectorAppsForTest()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return answer(url) }))
})
afterEach(() => vi.unstubAllGlobals())

function Row({ agentId, tool, wanted }: { agentId?: string; tool: string; wanted?: boolean }) {
    const apps = useDesktopConnectorApps(agentId, wanted)
    return <span>{resolveDesktopConnectorTool(tool, apps)?.label ?? 'plain'}</span>
}
async function mount(node: React.ReactNode) {
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    await act(async () => { root.render(node) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    return { container, async close() { await act(async () => root.unmount()); container.remove() } }
}

test('every row of a chat shares one read of the coworker’s apps', async () => {
    const view = await mount(<>{Array.from({ length: 30 }, (_, index) => <Row key={index} agentId="agent-1" tool="linear_create_issue" />)}</>)
    expect(view.container.textContent).toBe('Create Issue'.repeat(30))
    expect(calls).toEqual(['/api/desktop/coworkers/agent-1/connectors'])
    await view.close()
    // Reopened straight away, the chat reuses what was read.
    const again = await mount(<Row agentId="agent-1" tool="linear_create_issue" />)
    expect(again.container.textContent).toBe('Create Issue')
    expect(calls).toHaveLength(1)
    await again.close()
})

test('no coworker, a failed read or another coworker’s answer leaves rows plain', async () => {
    const none = await mount(<Row tool="linear_create_issue" />)
    expect(none.container.textContent).toBe('plain')
    expect(calls).toEqual([])
    await none.close()
    answer = () => Response.json({ error: 'no' }, { status: 404 })
    const failed = await mount(<Row agentId="agent-2" tool="linear_create_issue" />)
    expect(failed.container.textContent).toBe('plain')
    await failed.close()
    answer = () => Response.json(listing('someone-else'))
    const foreign = await mount(<Row agentId="agent-3" tool="linear_create_issue" />)
    expect(foreign.container.textContent).toBe('plain')
    await foreign.close()
})

test('a change to the coworker’s apps reaches an open chat with one more read', async () => {
    answer = () => Response.json({ agentId: 'agent-4', servers: [], toolkits: [] })
    const view = await mount(<Row agentId="agent-4" tool="linear_create_issue" />)
    expect(view.container.textContent).toBe('plain')
    answer = () => Response.json(listing('agent-4'))
    await act(async () => { invalidateDesktopConnectorApps('agent-4'); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(view.container.textContent).toBe('Create Issue')
    expect(calls).toHaveLength(2)
    await view.close()
})

test('a reply with no app step reads nothing, yet follows what a sibling read', async () => {
    const quiet = await mount(<Row agentId="agent-5" tool="linear_create_issue" wanted={false} />)
    expect(quiet.container.textContent).toBe('plain')
    expect(calls).toEqual([])
    const asking = await mount(<Row agentId="agent-5" tool="linear_create_issue" />)
    expect(calls).toHaveLength(1)
    expect(quiet.container.textContent).toBe('Create Issue')
    await quiet.close(); await asking.close()
})


test('a pending chat annotation read cannot hide a newer assignment', async () => {
    let settle!: (response: Response) => void
    answer = () => new Promise(resolve => { settle = resolve })
    const view = await mount(<Row agentId="agent-5" tool="linear_create_issue" />)
    answer = () => Response.json(listing('agent-5'))
    await act(async () => {
        invalidateDesktopConnectorApps()
        settle(Response.json({ agentId: 'agent-5', servers: [], toolkits: [] }))
        await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(calls).toHaveLength(2)
    expect(view.container.textContent).toBe('Create Issue')
    await view.close()
})
