// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { FieldFooter } from '@rerun/ui/new-agent'
import { DESCRIBED } from '@rerun/ui/new-agent/schedule'
import type { DesktopCreateOutcome, DesktopCreationIntent } from '@/lib/desktop/new-agent'
import { DesktopNewAgentDialog } from './DesktopNewAgentDialog'

// The Orb animates a canvas-like face; this is about the flow around it, not the drawing.
vi.mock('@rerun/ui/foreman', () => ({ Orb: () => null }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// happy-dom has no matchMedia, and the gaze hook reads it before the reduced-motion check.
beforeAll(() => {
    if (!window.matchMedia) window.matchMedia = ((query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as typeof window.matchMedia
})

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = '' })

const TEXT = 'Read every new support ticket and draft a reply for the ones about billing.'

const read = () => vi.fn(async () => ({ name: 'Billing Replies', apps: [], schedule: null }))

const field = () => document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!
const click = (label: string) => act(async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)
    expect(button, label).toBeDefined()
    button!.click()
})
const createButton = () => act(async () => {
    const button = document.querySelector<HTMLButtonElement>('[data-aim="create"]')
    expect(button).toBeDefined()
    button!.click()
})
const type = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field(), value)
    field().dispatchEvent(new Event('input', { bubbles: true }))
})

let root: Root

async function withDialog(onCreate: (intent: DesktopCreationIntent) => Promise<DesktopCreateOutcome>, action: () => Promise<void>, { open = true }: { open?: boolean } = {}) {
    const onOpenChange = vi.fn()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
        await act(async () => root.render(<DesktopNewAgentDialog open={open} onOpenChange={onOpenChange} onCreate={onCreate} read={read()} first />))
        await action()
    } finally {
        await act(async () => root.unmount())
    }
    return onOpenChange
}

test('typing and the name hint create nothing: no coworker, no chat, no message', async () => {
    const fetcher = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetcher)
    const onCreate = vi.fn(async () => ({ kind: 'created' as const }))
    await withDialog(onCreate, async () => {
        await type(TEXT)
        await act(async () => {})
        expect(field().value).toBe(TEXT)
        expect(onCreate).not.toHaveBeenCalled()
        expect(fetcher).not.toHaveBeenCalled()
    })
    expect(fetcher).not.toHaveBeenCalled()
})

test('Create hands root one intent carrying the description word for word', async () => {
    const onCreate = vi.fn(async (_intent: DesktopCreationIntent) => ({ kind: 'created' as const }))
    const onOpenChange = await withDialog(onCreate, async () => {
        await type(TEXT)
        await createButton()
    })
    expect(onCreate).toHaveBeenCalledTimes(1)
    const intent = onCreate.mock.calls[0][0] as DesktopCreationIntent
    expect(intent).toMatchObject({ name: 'Billing Replies', kickoff: TEXT, scheduled: false, suggestionId: null })
    expect(intent.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(onOpenChange).toHaveBeenCalledWith(false)
})

test('a rapid second press does not start a second coworker', async () => {
    let finish: (outcome: DesktopCreateOutcome) => void = () => {}
    const onCreate = vi.fn(() => new Promise<DesktopCreateOutcome>(resolve => { finish = resolve }))
    await withDialog(onCreate, async () => {
        await type(TEXT)
        await act(async () => {
            const button = document.querySelector<HTMLButtonElement>('[data-aim="create"]')!
            button.click()
            button.click()
        })
        await act(async () => {})
        expect(onCreate).toHaveBeenCalledTimes(1)
        await act(async () => { finish({ kind: 'created' }) })
    })
})

test('an uncertain creation is resumed with the same request id, never a second coworker', async () => {
    const ids: string[] = []
    const onCreate = vi.fn(async (intent: DesktopCreationIntent): Promise<DesktopCreateOutcome> => {
        ids.push(intent.requestId)
        return ids.length === 1 ? { kind: 'uncertain', error: 'gateway timeout' } : { kind: 'created' }
    })
    const onOpenChange = await withDialog(onCreate, async () => {
        await type(TEXT)
        await createButton()
        const alert = document.querySelector('[role="alert"]')
        expect(alert?.textContent).toContain('could not confirm')
        expect(document.body.textContent).toContain('gateway timeout')
        expect(field()).toBeNull()

        await click('Try again')
        expect(ids).toHaveLength(2)
        expect(ids[1]).toBe(ids[0])
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
})

test('an uncertain attempt cannot be abandoned for another request id', async () => {
    const ids: string[] = []
    const onCreate = vi.fn(async (intent: DesktopCreationIntent): Promise<DesktopCreateOutcome> => {
        ids.push(intent.requestId)
        return ids.length === 1 ? { kind: 'uncertain', error: 'gateway timeout' } : { kind: 'created' }
    })
    await withDialog(onCreate, async () => {
        await type(TEXT)
        await createButton()
        expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Start over')).toBe(false)
        expect(field()).toBeNull()
        await click('Try again')
        expect(ids).toHaveLength(2)
        expect(ids[1]).toBe(ids[0])
        expect(onCreate.mock.calls[1][0]).toMatchObject({ kickoff: TEXT })
    })
})

test('closing during a delayed hint prevents creation and an old hint cannot populate a reopened form', async () => {
    let finishRead!: (value: { name: string; apps: string[]; schedule: null }) => void
    const delayedRead = vi.fn(() => new Promise<{ name: string; apps: string[]; schedule: null }>(resolve => { finishRead = resolve }))
    const onCreate = vi.fn(async () => ({ kind: 'created' as const }))
    const onOpenChange = vi.fn()
    const localRoot = createRoot(document.body.appendChild(document.createElement('div')))
    const render = (open: boolean) => act(async () => localRoot.render(<DesktopNewAgentDialog open={open} onOpenChange={onOpenChange} onCreate={onCreate} read={delayedRead} />))
    try {
        await render(true)
        await type(TEXT)
        await createButton()
        expect(delayedRead).toHaveBeenCalledTimes(1)
        expect(document.querySelector<HTMLButtonElement>('[data-aim="create"]')?.disabled).toBe(true)
        await render(false)
        await render(true)
        await type('A different job for the new dialog.')
        await act(async () => { finishRead({ name: 'Late old name', apps: [], schedule: null }) })
        expect(onCreate).not.toHaveBeenCalled()
        expect(field().value).toBe('A different job for the new dialog.')
        expect(document.body.textContent).not.toContain('Late old name')
        expect(onOpenChange).not.toHaveBeenCalled()
    } finally { await act(async () => localRoot.unmount()) }
})

test('unmount during hint settlement never admits a creation', async () => {
    let finishRead!: (value: { name: string; apps: string[]; schedule: null }) => void
    const onCreate = vi.fn(async () => ({ kind: 'created' as const }))
    const localRoot = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => localRoot.render(<DesktopNewAgentDialog open onOpenChange={() => {}} onCreate={onCreate} read={() => new Promise(resolve => { finishRead = resolve })} />))
    await type(TEXT)
    await createButton()
    await act(async () => localRoot.unmount())
    await act(async () => { finishRead({ name: 'Late', apps: [], schedule: null }) })
    expect(onCreate).not.toHaveBeenCalled()
})

test('completion of an admitted attempt cannot close a newer dialog or replay its kickoff', async () => {
    let finish!: (outcome: DesktopCreateOutcome) => void
    const onCreate = vi.fn(() => new Promise<DesktopCreateOutcome>(resolve => { finish = resolve }))
    const onOpenChange = vi.fn()
    const localRoot = createRoot(document.body.appendChild(document.createElement('div')))
    const reader = read()
    const render = (open: boolean) => act(async () => localRoot.render(<DesktopNewAgentDialog open={open} onOpenChange={onOpenChange} onCreate={onCreate} read={reader} />))
    try {
        await render(true)
        await type(TEXT)
        await createButton()
        expect(onCreate).toHaveBeenCalledTimes(1)
        await render(false)
        await render(true)
        await act(async () => { finish({ kind: 'created' }) })
        expect(onOpenChange).not.toHaveBeenCalled()
        expect(document.querySelector('[role="dialog"]')).not.toBeNull()
        expect(document.body.textContent).toContain('Your coworker was created.')
        expect(document.querySelector('[data-aim="create"]')).toBeNull()
        expect(onCreate).toHaveBeenCalledTimes(1)
    } finally { await act(async () => localRoot.unmount()) }
})

test('receipt hydration blocks admission and remount resumes the exact durable intent without reading a new name', async () => {
    const resumeIntent: DesktopCreationIntent = { requestId: '4d6c8d52-616b-4434-a6bd-c270aa646e52', name: 'Saved name', kickoff: TEXT, suggestionId: null, scheduled: false }
    const onCreate = vi.fn(async () => ({ kind: 'uncertain' as const, error: 'still waiting' }))
    const reader = read()
    let localRoot = createRoot(document.body.appendChild(document.createElement('div')))
    try {
        await act(async () => localRoot.render(<DesktopNewAgentDialog open resolvingReceipt onOpenChange={() => {}} onCreate={onCreate} read={reader} />))
        expect(document.body.textContent).toContain('Checking your previous creation')
        expect(document.querySelector('[data-aim="create"]')).toBeNull()
        await act(async () => localRoot.render(<DesktopNewAgentDialog open resumeIntent={resumeIntent} onOpenChange={() => {}} onCreate={onCreate} read={reader} />))
        expect(field()).toBeNull()
        await click('Try again')
        expect(onCreate).toHaveBeenLastCalledWith(resumeIntent)
        await act(async () => localRoot.unmount())
        localRoot = createRoot(document.body.appendChild(document.createElement('div')))
        await act(async () => localRoot.render(<DesktopNewAgentDialog open resumeIntent={resumeIntent} onOpenChange={() => {}} onCreate={onCreate} read={reader} />))
        await click('Try again')
        expect(onCreate).toHaveBeenCalledTimes(2)
        expect(onCreate).toHaveBeenLastCalledWith(resumeIntent)
        expect(reader).not.toHaveBeenCalled()
    } finally { await act(async () => localRoot.unmount()) }
})

test('a refused creation keeps the description and says why, without closing', async () => {
    const onCreate = vi.fn(async () => ({ kind: 'refused' as const, error: 'A coworker named Billing Replies exists.' }))
    const onOpenChange = await withDialog(onCreate, async () => {
        await type(TEXT)
        await createButton()
        expect(document.querySelector('[role="alert"]')?.textContent).toBe('A coworker named Billing Replies exists.')
        expect(field().value).toBe(TEXT)
    })
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
})

test('offers no Apps, Schedule or template entry point it cannot honour', async () => {
    const onCreate = vi.fn(async () => ({ kind: 'created' as const }))
    await withDialog(onCreate, async () => {
        await type(TEXT)
        const labels = [...document.querySelectorAll('button')].map(button => button.textContent?.trim() ?? '')
        expect(labels.some(label => /Apps|Schedule|Templates?/i.test(label))).toBe(false)
        expect(document.body.textContent).not.toContain('Browse templates')
        expect(document.querySelector('[aria-label="Coworker name"]')).toBeNull()
        expect(labels.some(label => label === 'Name your coworker' || label.startsWith('Create'))).toBe(true)
    })
})

test('the shared footer keeps the hosted Apps and Schedule entry points unless a host turns them off', async () => {
    const show = async (capabilities?: { apps: boolean; schedule: boolean }) => {
        const host = document.body.appendChild(document.createElement('div'))
        const localRoot = createRoot(host)
        try {
            await act(async () => localRoot.render(<FieldFooter
                name="Researcher"
                nameProps={{ editing: false, onEdit: () => {}, onRename: () => {}, onCancel: () => {} }}
                catalog={null}
                apps={[]}
                onToggleApp={() => {}}
                schedule={{ read: null, choice: DESCRIBED, onChoice: () => {}, open: false, onOpenChange: () => {} }}
                canCreate
                creating={false}
                {...(capabilities ? { capabilities } : {})}
            />))
            return [...host.querySelectorAll('button')].map(button => button.textContent?.trim() ?? '')
        } finally {
            await act(async () => localRoot.unmount())
        }
    }

    const hosted = await show()
    expect(hosted).toContain('Apps')
    expect(hosted).toContain('Schedule')
    expect(hosted.some(label => label.startsWith('Create'))).toBe(true)

    const mac = await show({ apps: false, schedule: false })
    expect(mac.some(label => /Apps|Schedule/.test(label))).toBe(false)
    expect(mac).toContain('Researcher')
})
