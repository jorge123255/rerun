// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { connectorAnswerText, DesktopConnectorApprovals } from './DesktopConnectorApprovals'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = ''; vi.unstubAllGlobals() })

const ID = '11111111-1111-4111-8111-111111111111', RULE = '22222222-2222-4222-8222-222222222222'
const pending = [{ id: ID, tool: 'gmail_send_email', kind: 'send', preview: '{"to":"pat@example.test"}', createdAt: '2026-11-14T12:00:00.000Z' }]

async function mount(views: unknown[], generating = false, coworkerName?: string) {
    const calls: { url: string; body?: unknown }[] = []
    let view = views[0]
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
        if (init?.method === 'POST') {
            view = views[Math.min(views.length - 1, 1)]
            const body = JSON.parse(String(init.body))
            const asked = (views[0] as { pending: { tool: string; kind: string }[] }).pending[0]
            return Response.json(body.action === 'decide' ? { tool: asked?.tool ?? 'gmail_send_email', kind: asked?.kind ?? 'send', decision: body.decision } : { ok: true })
        }
        return Response.json(view)
    }))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    const onAnswered = vi.fn()
    await act(async () => { root.render(<DesktopConnectorApprovals sessionId="chat 1" generating={generating} disabled={false} onAnswered={onAnswered} coworkerName={coworkerName} />) })
    await act(async () => { await Promise.resolve() })
    return { host, calls, onAnswered }
}
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(node => node.textContent === text)!

test('shows nothing while no action is waiting and nothing is allowed', async () => {
    const { host, calls } = await mount([{ pending: [], rules: [] }])
    expect(host.textContent).toBe('')
    expect(calls[0]!.url).toBe('/api/desktop/sessions/chat%201/connector-approvals')
})

test('asks about a held action and tells the coworker the answer', async () => {
    const { host, calls, onAnswered } = await mount([{ pending, rules: [] }, { pending: [], rules: [{ id: RULE, tool: 'gmail_send_email', scope: 'conversation' }] }])
    expect(host.textContent).toContain('Allow Gmail Send Email?')
    expect(host.textContent).toContain('This sends something to other people.')
    expect(host.textContent).toContain('pat@example.test')
    expect([...host.querySelectorAll('section button')].map(node => node.textContent)).toEqual(['Allow once', 'Allow for this conversation', 'Always allow', 'Deny'])

    await act(async () => { button(host, 'Allow for this conversation').click() })
    await act(async () => { await Promise.resolve() })
    expect(calls.find(call => call.body)!.body).toEqual({ action: 'decide', id: ID, decision: 'conversation' })
    expect(onAnswered).toHaveBeenCalledWith('Allowed: Gmail Send Email. Run it now with exactly the same arguments.')
    expect(host.querySelector('section')).toBeNull()
    expect(host.textContent).toContain('Allowed without asking')
    expect(host.textContent).toContain('Gmail Send Email · this conversation')

    await act(async () => { button(host, 'Turn off').click() })
    await act(async () => { await Promise.resolve() })
    expect(calls.filter(call => call.body).at(-1)!.body).toEqual({ action: 'forget', ruleId: RULE })
    expect(onAnswered).toHaveBeenCalledTimes(1)
})

test('cannot be answered while the coworker is still replying', async () => {
    const { host } = await mount([{ pending, rules: [] }], true)
    for (const node of host.querySelectorAll<HTMLButtonElement>('section button')) expect(node.disabled).toBe(true)
})

test('a refusal is worded as a refusal', () => {
    expect(connectorAnswerText('drive_delete_file', 'deny')).toBe('Declined: Drive Delete File. I decided not to have this done. Do not do it, or anything equivalent, another way; tell me briefly what you did not do.')
})

test('a held message is shown as a message: To, Subject and its text, not as JSON', async () => {
    const preview = JSON.stringify({ v: 1, items: [{ tool: 'GMAIL_SEND_EMAIL', fields: [
        ['recipient_email', 'pat@example.test'], ['cc', '["sam@example.test","lee@example.test"]'], ['subject', 'Quarterly numbers'],
        ['body', 'Hi Pat,\n\nThe numbers are attached.'], ['include_signature', 'false'],
    ] }] })
    const { host } = await mount([{ pending: [{ id: ID, tool: 'GMAIL_SEND_EMAIL', kind: 'send', preview, createdAt: '2026-11-14T12:00:00.000Z' }], rules: [] }])
    const card = host.querySelector('[data-testid="desktop-connector-preview"]')!
    expect(card.textContent).not.toContain('{')
    expect([...card.querySelectorAll('dt')].slice(0, 3).map(node => node.textContent)).toEqual(['To', 'Cc', 'Subject'])
    expect([...card.querySelectorAll('dd')].slice(0, 3).map(node => node.textContent)).toEqual(['pat@example.test', 'sam@example.test, lee@example.test', 'Quarterly numbers'])
    expect(card.querySelector('p.whitespace-pre-wrap')!.textContent).toBe('Hi Pat,\n\nThe numbers are attached.')
    // What is not part of the message sits under More details.
    expect(card.querySelector('details')!.textContent).toContain('Include signature')
    expect(host.querySelector('pre')).toBeNull()
})

test('another action shows its named values, sandbox code shows as code, and an old request shows its text', async () => {
    const shaped = (preview: string) => [{ pending: [{ id: ID, tool: 'drive_delete_file', kind: 'delete', preview, createdAt: '2026-11-14T12:00:00.000Z' }], rules: [] }]
    const values = await mount(shaped(JSON.stringify({ v: 1, items: [{ fields: [['file_id', 'abc123'], ['permanent', 'true']] }] })))
    expect([...values.host.querySelectorAll('dt')].map(node => node.textContent)).toEqual(['File id', 'Permanent'])
    const code = await mount(shaped(JSON.stringify({ v: 1, items: [{ code: 'run_composio_tool("GMAIL_SEND_EMAIL", p)' }] })))
    expect(code.host.textContent).toContain('Code it would run')
    expect(code.host.querySelector('pre')!.textContent).toBe('run_composio_tool("GMAIL_SEND_EMAIL", p)')
    const old = await mount(shaped('{"to":"pat@example.test"}'))
    expect(old.host.querySelector('pre')!.textContent).toBe('{"to":"pat@example.test"}')
})

const press = (label: string, host: string, kind = 'pay', via = 'click') => [{ id: ID, tool: 'browser_press', kind, preview: JSON.stringify({ v: 1, items: [], press: { label, host, via } }), createdAt: '2026-11-14T12:00:00.000Z' }]

test('asks about a press in the browser by its label and site, with Allow once and Deny only', async () => {
    const { host, calls, onAnswered } = await mount([{ pending: press('Pay now', 'checkout.example.test'), rules: [] }, { pending: [], rules: [] }], false, 'Ada')
    expect(host.querySelector('[data-testid=desktop-browser-press-approval]')!.getAttribute('aria-label')).toBe('Ada wants to press “Pay now” on checkout.example.test')
    expect(host.textContent).toContain('This pays or moves money.')
    expect(host.textContent).toContain('Allowing covers this one press.')
    expect([...host.querySelectorAll('section button')].map(node => node.textContent)).toEqual(['Allow once', 'Deny'])
    await act(async () => { button(host, 'Allow once').click() })
    await act(async () => { await Promise.resolve() })
    expect(calls.find(call => call.body)!.body).toEqual({ action: 'decide', id: ID, decision: 'once' })
    // The page's words never go into the message the coworker reads as the person's.
    expect(onAnswered).toHaveBeenCalledWith('Allowed once: the press in the browser you asked about. Make exactly the same press now. It covers that one press only.')
    expect(onAnswered.mock.calls[0]![0]).not.toContain('Pay now')
})

test('declining a press tells the coworker not to look for another way', async () => {
    const { host, onAnswered } = await mount([{ pending: press('Delete account', 'app.example.test', 'delete'), rules: [] }, { pending: [], rules: [] }])
    expect(host.textContent).toContain('This coworker wants to press “Delete account” on app.example.test')
    await act(async () => { button(host, 'Deny').click() })
    await act(async () => { await Promise.resolve() })
    expect(onAnswered).toHaveBeenCalledWith('Declined: the press in the browser you asked about. I decided not to have this done. Do not do it, or anything equivalent, another way; tell me briefly what you did not do.')
})

test('names an unlabelled control and a key press honestly, and shows page text as text', async () => {
    const unlabelled = await mount([{ pending: press('', 'canvas.example.test', 'press'), rules: [] }], false, 'Ada')
    expect(unlabelled.host.textContent).toContain('Ada wants to press an unlabelled control on canvas.example.test')
    expect(unlabelled.host.textContent).toContain('Extra vigilant is on for this coworker')
    const key = await mount([{ pending: press('<img src=x onerror=alert(1)>', '', 'send', 'key'), rules: [] }], false, 'Ada')
    expect(key.host.textContent).toContain('Ada wants to press Enter for “<img src=x onerror=alert(1)>” on this page')
    expect(key.host.querySelector('img')).toBeNull()
})

const github = (tool: string) => [{ id: ID, tool, kind: 'repository', preview: JSON.stringify({ v: 1, items: [{ fields: [['owner', 'acme'], ['repo', 'openflix']] }] }), createdAt: '2026-11-16T12:00:00.000Z' }]

test('a change to a GitHub repository says so and may get a standing answer', async () => {
    const { host } = await mount([{ pending: github('github_create_pull_request'), rules: [] }])
    expect(host.textContent).toContain('This changes a GitHub repository.')
    expect([...host.querySelectorAll('section button')].map(node => node.textContent)).toEqual(['Allow once', 'Allow for this conversation', 'Always allow', 'Deny'])
})

test('merging a pull request or deleting a file offers Allow once and Deny only', async () => {
    for (const tool of ['github_merge_pull_request', 'GITHUB_DELETE_A_FILE', 'GITHUB_DELETE_A_REFERENCE+GITHUB_CREATE_AN_ISSUE']) {
        const { host } = await mount([{ pending: github(tool), rules: [] }])
        expect([...host.querySelectorAll('section button')].map(node => node.textContent), tool).toEqual(['Allow once', 'Deny'])
    }
})
