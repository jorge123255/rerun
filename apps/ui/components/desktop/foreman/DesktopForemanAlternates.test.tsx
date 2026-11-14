// @vitest-environment happy-dom
import { act, type MouseEvent, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopForemanAnswerActions } from './DesktopForemanAnswerActions'
import { DesktopForemanAlternateReview, DesktopForemanAlternates } from './DesktopForemanAlternates'
import { useDesktopForemanAlternates } from './useDesktopForemanAlternates'

vi.mock('@/components/dialogs/ConfirmDialog', () => ({
    ConfirmDialog: (props: { open: boolean; confirmLabel: string; description: ReactNode; onConfirm: (event: MouseEvent) => void }) => props.open
        ? <div role="alertdialog">{props.description}<button onClick={props.onConfirm}>{props.confirmLabel}</button></div> : null,
}))

const chat = { workspaceId: '1', chatId: 'fmc_saved-retry' }
const messageId = 'engine-saved-1'
const snapshot = 'a'.repeat(64)
let root: Root | undefined
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
})

function Host({ revision = snapshot }: { revision?: string }) {
    const ui = useDesktopForemanAlternates({ chat, snapshot: revision, active: true, eligible: true })
    return <>
        <div hidden={ui.open}>
            <p>Original saved answer</p>
            <DesktopForemanAnswerActions rating="up" onRate={() => {}} onReviewRetry={() => void ui.reviewReply(messageId)} retryDisabled={ui.busy} />
            {ui.items.length > 0 && <button onClick={ui.openList}>Reply retries</button>}
        </div>
        {ui.open && <DesktopForemanAlternates ui={ui} sourceText={() => 'Original saved answer'} />}
        <DesktopForemanAlternateReview ui={ui} />
    </>
}

async function render(revision = snapshot) {
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Host revision={revision} />))
}

async function click(label: string, scope: ParentNode = document) {
    const button = [...scope.querySelectorAll('button')].find(button =>
        (button.getAttribute('aria-label') === label || button.textContent?.trim() === label) && !button.closest('[hidden]'))
    expect(button, label).toBeDefined()
    await act(async () => button!.click())
}

it('reviews before dispatch, stops the exact retry and reopens the saved result with read-only requests', async () => {
    const calls: { action: string; requestId?: string }[] = []
    let requestId: string | undefined
    let status = 'prepared'
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const parsed = new URL(url, 'http://127.0.0.1')
        if (!init?.body) {
            const opened = parsed.searchParams.get('requestId')
            calls.push({ action: opened ? 'read' : 'list', ...(opened && { requestId: opened }) })
            expect(parsed.searchParams.get('chatId')).toBe(chat.chatId)
            if (!opened) return Response.json({ items: requestId ? [{ requestId, messageId }] : [] })
            expect(opened).toBe(requestId)
            return Response.json({ requestId, status, messages: [{ id: 'saved-retry', role: 'assistant', text: 'Saved alternate draft' }] })
        }
        const body = JSON.parse(String(init.body))
        expect(body.chat).toEqual(chat)
        calls.push({ action: body.action, ...(body.requestId && { requestId: body.requestId }) })
        if (body.action === 'review') {
            expect(body).toMatchObject({ messageId, snapshot })
            return Response.json({ ok: true })
        }
        if (body.action === 'prepare') {
            requestId = body.requestId
            expect(body).toMatchObject({ messageId, snapshot })
        } else {
            expect(body.requestId).toBe(requestId)
            status = body.action === 'start' ? 'running' : 'cancelled'
        }
        return Response.json({ requestId, status })
    }))
    await render()
    expect(calls.map(call => call.action)).toEqual(['list'])
    await click('Regenerate')
    expect(calls.map(call => call.action)).toEqual(['list', 'review'])
    await click('Regenerate', document.querySelector('[role=alertdialog]')!)
    expect(calls.filter(call => ['prepare', 'start'].includes(call.action))).toEqual([
        { action: 'prepare', requestId }, { action: 'start', requestId },
    ])
    expect(document.body.textContent).toContain('Saved alternate draft')
    await click('Stop')
    expect(calls.filter(call => call.action === 'stop')).toEqual([{ action: 'stop', requestId }])
    expect(document.body.textContent).toContain('Retry stopped.')
    await click('Original conversation')
    expect(document.querySelector('button[aria-pressed="true"]')?.textContent?.trim()).toBe('Good response')
    const beforeReopen = calls.length
    await act(async () => root!.unmount()); root = undefined
    await render()
    await click('Reply retries')
    await click('Retry 1Original saved answer')
    expect(document.body.textContent).toContain('Saved alternate draft')
    expect(calls.slice(beforeReopen)).toEqual([{ action: 'list' }, { action: 'read', requestId }])
})

it('drops a reviewed action when the rendered snapshot changes', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => Response.json(init?.body ? { ok: true } : { items: [] }))
    vi.stubGlobal('fetch', fetcher)
    await render()
    await click('Regenerate')
    expect(document.querySelector('[role=alertdialog]')).toBeTruthy()
    await render('b'.repeat(64))
    expect(document.querySelector('[role=alertdialog]')).toBeNull()
    expect(fetcher.mock.calls.filter(([, init]) => init?.body).map(([, init]) => JSON.parse(String(init!.body)).action)).toEqual(['review'])
})
