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

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = '' })

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
    const onCreate = vi.fn(async () => ({ kind: 'created' as const }))
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

test('Start over is the only way to begin a different creation after an uncertain one', async () => {
    const ids: string[] = []
    const onCreate = vi.fn(async (intent: DesktopCreationIntent): Promise<DesktopCreateOutcome> => {
        ids.push(intent.requestId)
        return ids.length === 1 ? { kind: 'uncertain', error: 'gateway timeout' } : { kind: 'created' }
    })
    await withDialog(onCreate, async () => {
        await type(TEXT)
        await createButton()
        await click('Start over')
        expect(field()).not.toBeNull()
        expect(field().value).toBe(TEXT)

        await type(`${TEXT} Ask before refunds.`)
        await createButton()
        expect(ids).toHaveLength(2)
        expect(ids[1]).not.toBe(ids[0])
        expect(onCreate.mock.calls[1][0]).toMatchObject({ kickoff: `${TEXT} Ask before refunds.` })
    })
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
