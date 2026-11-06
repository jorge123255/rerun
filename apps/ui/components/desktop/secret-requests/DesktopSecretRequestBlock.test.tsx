// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopSecretRequestView } from '@rerun/contracts'
import { DesktopSecretRequestBlock } from './DesktopSecretRequestBlock'

vi.mock('@rerun/ui', () => ({ BorderBeam: () => null }))
const roots: Root[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.unstubAllGlobals(); vi.restoreAllMocks()
})

const request: DesktopSecretRequestView = {
    requestId: 'request', revision: 'revision',
    source: { agentId: 'agent', sessionId: 'chat', runId: 'run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'fingerprint' },
    reason: 'Use the Example API.', fields: [{ key: 'EXAMPLE_API_KEY', label: 'Example API key', help: 'Create a test key.', docsUrl: 'https://example.com/keys', existing: true }, { key: 'OTHER_TOKEN', label: 'Other token', existing: false }],
    status: 'pending', createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
}

async function mount(view = request, onAccepted = vi.fn()) {
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    await act(async () => root.render(<DesktopSecretRequestBlock sessionId="chat" request={view} onAccepted={onAccepted} />))
    return { root, onAccepted }
}
const input = (key: string) => document.querySelector<HTMLInputElement>(`[data-hitl="secret-${key}"]`)!
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)!
async function type(key: string, value: string) {
    const field = input(key)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    await act(async () => field.dispatchEvent(new Event('input', { bubbles: true })))
}
const click = async (label: string) => { await act(async () => { button(label).click() }) }
const acknowledged = () => new Response('data: [DONE]\n\n', { headers: { 'x-secret-request-id': 'request', 'x-run-id': 'continuation', 'x-session-id': 'chat' } })

test('draws the original masked form, labels, help, docs and existing-key indicator without auto-submit', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    await mount()
    expect(document.body.textContent).toContain('Credentials needed')
    expect(document.body.textContent).toContain('Use the Example API.')
    expect(document.body.textContent).toContain('Create a test key.')
    expect(document.body.textContent).toContain('Stored as EXAMPLE_API_KEY')
    expect(input('EXAMPLE_API_KEY').type).toBe('password')
    expect(input('EXAMPLE_API_KEY').placeholder).toContain('Already saved')
    expect(document.querySelector('a')?.href).toBe('https://example.com/keys')
    expect(document.body.textContent).toContain('Stored encrypted for this coworker. Never sent to the model.')
    expect(fetcher).not.toHaveBeenCalled()
})

test('Save preserves exact bytes and clears sensitive fields only after acknowledgement', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => acknowledged()); vi.stubGlobal('fetch', fetcher)
    const { onAccepted } = await mount()
    await type('EXAMPLE_API_KEY', '  exact bytes  ')
    await click('Save')
    const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(payload.values.EXAMPLE_API_KEY).toBe('  exact bytes  ')
    expect(input('EXAMPLE_API_KEY').value).toBe('')
    expect(onAccepted).toHaveBeenCalledTimes(1)
})

test('a failed Save keeps the active value and retry uses the same attempt without latching', async () => {
    const fetcher = vi.fn()
        .mockResolvedValueOnce(Response.json({ error: 'Save acknowledgement unknown.' }, { status: 502 }))
        .mockResolvedValueOnce(acknowledged())
    vi.stubGlobal('fetch', fetcher)
    await mount()
    await type('EXAMPLE_API_KEY', 'dummy-secret')
    await click('Save')
    expect(input('EXAMPLE_API_KEY').value).toBe('dummy-secret')
    expect(document.body.textContent).toContain('Save acknowledgement unknown.')
    expect(button('Save').disabled).toBe(false)
    await click('Save')
    const first = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    const second = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))
    expect(second.attemptId).toBe(first.attemptId)
    expect(input('EXAMPLE_API_KEY').value).toBe('')
})

test('owner change and disposal clear sensitive form state and ignore late acknowledgement', async () => {
    let resolve!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done })))
    const { root, onAccepted } = await mount()
    await type('EXAMPLE_API_KEY', 'dummy-secret')
    await click('Save')
    await act(async () => root.render(<DesktopSecretRequestBlock sessionId="other-chat" request={{ ...request, requestId: 'other-request', source: { ...request.source, sessionId: 'other-chat' } }} onAccepted={onAccepted} />))
    expect(input('EXAMPLE_API_KEY').value).toBe('')
    await type('EXAMPLE_API_KEY', 'replacement-owner-value')
    await act(async () => resolve(acknowledged()))
    expect(onAccepted).not.toHaveBeenCalled()
    expect(input('EXAMPLE_API_KEY').value).toBe('replacement-owner-value')
    expect(button('Save').disabled).toBe(false)
})

test('a late old-owner failure cannot publish an error or clear the replacement form', async () => {
    let reject!: (error: Error) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((_done, fail) => { reject = fail })))
    const { root } = await mount()
    await type('EXAMPLE_API_KEY', 'first-owner-value')
    await click('Save')
    await act(async () => root.render(<DesktopSecretRequestBlock sessionId="other-chat" request={{ ...request, requestId: 'other-request', source: { ...request.source, sessionId: 'other-chat' } }} />))
    await type('EXAMPLE_API_KEY', 'second-owner-value')
    await act(async () => reject(new Error('Old request failed')))
    expect(document.body.textContent).not.toContain('Old request failed')
    expect(input('EXAMPLE_API_KEY').value).toBe('second-owner-value')
    expect(button('Save').disabled).toBe(false)
})

test.each(['staged', 'sealed'] as const)('reopened %s decision waits for explicit metadata-only recovery', async state => {
    const fetcher = vi.fn<typeof fetch>(async () => acknowledged())
    vi.stubGlobal('fetch', fetcher)
    const view: DesktopSecretRequestView = {
        ...request, status: state === 'staged' ? 'pending' : 'sealed',
        pendingAttempt: { attemptId: 'durable-attempt', operation: 'save', state },
        ...(state === 'sealed' ? { receipt: {
            attemptId: 'durable-attempt', decision: 'save' as const, providedKeys: ['EXAMPLE_API_KEY'], skippedKeys: ['OTHER_TOKEN'],
            summary: 'Credential setup result', continuationRequestId: 'continuation', accepted: false, createdAt: '2026-11-05T00:00:00.000Z',
        } } : {}),
    }
    const { onAccepted } = await mount(view)
    expect(fetcher).not.toHaveBeenCalled()
    expect(input('EXAMPLE_API_KEY')).toBeNull()
    await click('Resume saved decision')
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
        operation: 'recover', requestId: request.requestId, attemptId: 'durable-attempt', expectedRevision: request.revision, source: request.source,
    })
    expect(onAccepted).toHaveBeenCalledTimes(1)
})

test('receipt projection contains only key names and provided/skipped state', async () => {
    await mount({ ...request, status: 'accepted', receipt: { attemptId: 'attempt', decision: 'save', providedKeys: ['EXAMPLE_API_KEY'], skippedKeys: ['OTHER_TOKEN'], summary: 'Credential setup result', continuationRequestId: 'continuation', accepted: true, createdAt: '2026-11-05T00:00:00.000Z' } })
    expect(document.body.textContent).toContain('1 of 2 stored')
    expect(document.body.textContent).toContain('EXAMPLE_API_KEY')
    expect(document.body.textContent).toContain('OTHER_TOKEN')
    expect(document.body.textContent).not.toContain('Paste the value')
})


test('an accepted response transfers stream cancellation to chat before the completed form unmounts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => acknowledged()))
    let adopted: { signal: AbortSignal; cancelStream: () => void } | undefined
    const onAccepted = vi.fn((_response: Response, stream: { signal: AbortSignal; cancelStream: () => void }) => { adopted = stream })
    const { root } = await mount(request, onAccepted)
    await type('EXAMPLE_API_KEY', 'fixture-secret')
    await click('Save')
    await act(async () => root.render(null))
    expect(adopted?.signal.aborted).toBe(false)
    adopted!.cancelStream()
    expect(adopted?.signal.aborted).toBe(true)
})
