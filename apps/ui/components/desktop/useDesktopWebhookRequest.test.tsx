// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDesktopWebhookRequest } from './useDesktopWebhookRequest'
import { testTriggerView as view } from '@/lib/desktop/trigger-requests/fixtures.test-support'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })
function Probe({ sessionId = view.link.sessionId, active = true }) { const saved = useDesktopWebhookRequest(view.link.agentId, sessionId, active, 0); return <span>{saved?.key ?? 'none'}</span> }
it('does not poll hidden chats or dispatch actions while loading canonical request metadata', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ request: view })); vi.stubGlobal('fetch', fetcher)
    await act(async () => root.render(<Probe active={false} />)); expect(fetcher).not.toHaveBeenCalled()
    await act(async () => root.render(<Probe />))
    expect(host.textContent).toBe(view.key); expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/desktop/sessions/${encodeURIComponent(view.link.sessionId)}/trigger-requests`)
    expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})
it('a held old-session result never replaces the selected chat request', async () => {
    let finish!: (response: Response) => void
    const held = new Promise<Response>(resolve => { finish = resolve })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => String(url).includes(encodeURIComponent(view.link.sessionId)) ? held : Response.json({ request: null })))
    await act(async () => root.render(<Probe />))
    await act(async () => root.render(<Probe sessionId="other-session" />))
    await act(async () => finish(Response.json({ request: view })))
    expect(host.textContent).toBe('none')
})
