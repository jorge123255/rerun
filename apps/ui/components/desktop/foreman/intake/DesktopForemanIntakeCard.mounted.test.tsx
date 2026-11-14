// @vitest-environment happy-dom
import { act, StrictMode, useLayoutEffect, type HTMLAttributes, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_DRAFT, toIntake, type DesktopForemanChatRef, type DesktopForemanIntakeCompletionAuthority, type DesktopForemanIntakeSaveInput, type TemplateCategory } from '@rerun/contracts'
import { cancelDraftShutdown, flushDesktopDrafts, isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { createMemoryDesktopForemanIntakeStore } from '@/lib/desktop/server/foreman-intake/store'
import { flushDesktopForemanIntakeWrites, useDesktopForemanIntake, type DesktopForemanIntakeClientPorts, type DesktopForemanIntakeController } from '@/lib/desktop/foreman-intake'
import { DesktopForemanIntakeCard } from './DesktopForemanIntakeCard'

type MotionLeafProps<T extends HTMLElement> = HTMLAttributes<T> & { layout?: unknown; initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown }

// Retain the real card, controls, hook and CAS store. Happy-dom animation cancellation
// is not part of their lifecycle contract; render motion leaves as ordinary DOM nodes.
vi.mock('motion/react', () => {
    function domProps<T extends HTMLElement>(props: MotionLeafProps<T>) {
        const clean = { ...props }
        delete clean.layout; delete clean.initial; delete clean.animate; delete clean.exit; delete clean.transition
        return clean
    }
    return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    useReducedMotion: () => true,
    motion: {
        div: function MockMotionDiv(props: MotionLeafProps<HTMLDivElement>) { return <div {...domProps(props)} /> },
        span: function MockMotionSpan(props: MotionLeafProps<HTMLSpanElement>) { return <span {...domProps(props)} /> },
    },
    }
})
vi.mock('./DesktopAnimatedHeight', () => ({ DesktopAnimatedHeight: ({ children }: { children: ReactNode }) => <div>{children}</div> }))

let root: Root | undefined
let controller: DesktopForemanIntakeController
let sequence = 0
const chatOf = (): DesktopForemanChatRef => ({ workspaceId: 'ws-intake-mounted', chatId: `fmc_mounted${String(++sequence).padStart(8, '0')}` })
function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}
function fixture() {
    const store = createMemoryDesktopForemanIntakeStore({ knownFirstName: 'Ada' })
    type Identity = Parameters<DesktopForemanIntakeCompletionAuthority['lookup']>[0]
    const receipts = new Map<string, Identity & { conversationId: string; runId: string; industry: TemplateCategory | null }>()
    const deliverRecord = (input: Parameters<DesktopForemanIntakeCompletionAuthority['deliver']>[0]) => {
        const value = { chat: input.chat, requestId: input.requestId, fingerprint: input.fingerprint, conversationId: 'same-foreman-session', runId: input.requestId, industry: input.answers.industry ?? input.answers.decidedIndustry }
        receipts.set(input.requestId, value)
        return value
    }
    const authority = { lookup: vi.fn(async (input: Identity) => receipts.get(input.requestId) ?? null), deliver: vi.fn(async (input: Parameters<DesktopForemanIntakeCompletionAuthority['deliver']>[0]) => deliverRecord(input)) }
    const ports = {
        read: vi.fn<DesktopForemanIntakeClientPorts['read']>(chat => store.read(chat)),
        save: vi.fn<DesktopForemanIntakeClientPorts['save']>(input => store.save(input)),
        complete: vi.fn<DesktopForemanIntakeClientPorts['complete']>(input => store.complete(input, authority)),
        lookupCompletion: vi.fn<DesktopForemanIntakeClientPorts['lookupCompletion']>((chat, id) => store.lookupCompletion(chat, id)),
    }
    const seed = (chat: DesktopForemanChatRef, patch: Partial<DesktopForemanIntakeSaveInput> = {}) => store.save({ chat, requestId: crypto.randomUUID(), baseRevision: 0, stepIndex: 1, draft: { ...EMPTY_DRAFT, companyUrl: 'saved.example' }, decidedIndustry: null, knownFirstName: 'Ada', ...patch })
    return { store, ports, authority, deliverRecord, seed }
}
function Host({ chat, ports, active = true }: { chat: DesktopForemanChatRef; ports: DesktopForemanIntakeClientPorts; active?: boolean }) {
    const current = useDesktopForemanIntake({ chat, ports, active })
    useLayoutEffect(() => { controller = current }, [current])
    return <><DesktopForemanIntakeCard intake={current} autoFocus={false} /><output data-step>{current.step}</output><output data-site>{current.siteRead}</output></>
}
async function render(chat: DesktopForemanChatRef, ports: DesktopForemanIntakeClientPorts, active = true, strict = false) {
    if (!root) root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(strict ? <StrictMode><Host chat={chat} ports={ports} active={active} /></StrictMode> : <Host chat={chat} ports={ports} active={active} />))
}
async function click(label: string) {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label)
    expect(button).toBeDefined()
    await act(async () => button!.click())
}
beforeEach(() => { cancelDraftShutdown(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.unstubAllGlobals()
    cancelDraftShutdown()
})

describe('mounted Foreman intake lifecycle', () => {
    it('offers Skip for a social profile without reading it and continues to the industry question', async () => {
        vi.useFakeTimers()
        const chat = chatOf(), f = fixture()
        const decideIndustry = vi.fn(async () => 'saas' as const)
        const analyzeSite = vi.fn(async () => ({ state: 'ready' as const }))
        await render(chat, { ...f.ports, decideIndustry, analyzeSite })
        await act(async () => controller.set({ companyUrl: 'https://www.linkedin.com/company/example' }))
        await act(async () => { await vi.advanceTimersByTimeAsync(700) })

        expect(document.querySelector('input')?.getAttribute('aria-invalid')).toBe('true')
        expect(document.querySelector('[data-foreman-intake]')?.textContent).toContain('linkedin.com')
        expect(controller.canAdvance).toBe(false)
        expect(controller.siteRead).toBeNull()
        expect(decideIndustry).not.toHaveBeenCalled()
        expect(analyzeSite).not.toHaveBeenCalled()
        await act(async () => controller.next())
        expect(controller.step).toBe('company')
        await click('Skip')
        expect(controller.step).toBe('industry')
        expect((await f.store.read(chat)).session.draft).toMatchObject({ companyUrl: '', websiteSkipped: true })
        expect(f.ports.complete).not.toHaveBeenCalled()
    })

    it('omits a saved social profile and its inferred industry when sending a direct request', async () => {
        const chat = chatOf(), f = fixture()
        await f.seed(chat, { draft: { ...EMPTY_DRAFT, companyUrl: 'm.facebook.com/acme' }, decidedIndustry: 'saas' })
        await render(chat, f.ports)
        expect(controller.step).toBe('company')
        expect(controller.industry).toBeNull()
        await act(async () => { expect(await controller.sendOwn('Help organize our design work.')).toBe(true) })
        expect(f.authority.deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            answers: expect.objectContaining({ companyUrl: null, decidedIndustry: null, ownAsk: 'Help organize our design work.' }),
        }))
    })

    it('gates fields during restore, shows a real read failure, and restores on explicit retry', async () => {
        const chat = chatOf(), f = fixture(), read = deferred<Awaited<ReturnType<typeof f.ports.read>>>()
        f.ports.read.mockImplementationOnce(() => read.promise)
        await render(chat, f.ports)
        expect(document.querySelector('input')).toBeNull()
        expect(controller.restored).toBe(false)
        await act(async () => read.reject(new Error('Could not restore the saved intake.')))
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not restore')
        await click('Try again')
        expect(controller.restored).toBe(true)
        expect(document.querySelector('input')?.getAttribute('placeholder')).toBe('acme.com')
        expect(f.ports.save).not.toHaveBeenCalled()
        expect(f.ports.complete).not.toHaveBeenCalled()
    })

    it('restores an acknowledged website without reclassifying, rereading or completing', async () => {
        vi.useFakeTimers()
        const chat = chatOf(), f = fixture()
        const view = await f.seed(chat, { draft: { ...EMPTY_DRAFT, companyUrl: 'saved.example', position: 'Founder' } })
        await f.store.complete({ chat, requestId: crypto.randomUUID(), expectedRevision: view.session.revision, answers: toIntake(view.session.draft, 'Ada', null) }, f.authority)
        const decideIndustry = vi.fn(async () => 'saas' as const), analyzeSite = vi.fn(async () => ({ state: 'ready' as const }))
        await render(chat, { ...f.ports, decideIndustry, analyzeSite })
        await act(async () => { await vi.advanceTimersByTimeAsync(700) })
        expect(controller.finished).toBe(true)
        expect(controller.hasSavedProgress).toBe(true)
        expect(document.querySelector('input')).toBeNull()
        expect(decideIndustry).not.toHaveBeenCalled()
        expect(analyzeSite).not.toHaveBeenCalled()
        expect(f.ports.complete).not.toHaveBeenCalled()
    })

    it('replays an immutable lost-ACK draft before saving newer local edits', async () => {
        const chat = chatOf(), f = fixture()
        f.ports.save.mockImplementationOnce(async input => { await f.store.save(input); throw new Error('The save response was interrupted.') })
        await render(chat, f.ports)
        await act(async () => controller.set({ companyUrl: 'first.example' }))
        expect(controller.saveFailed).toBe(true)
        await act(async () => controller.set({ companyUrl: 'newer.example' }))
        expect(f.ports.save).toHaveBeenCalledTimes(1)
        await click('Retry saving')
        expect(f.ports.save).toHaveBeenCalledTimes(3)
        expect(f.ports.save.mock.calls[1][0]).toEqual(f.ports.save.mock.calls[0][0])
        expect(f.ports.save.mock.calls[2][0].requestId).not.toBe(f.ports.save.mock.calls[0][0].requestId)
        expect((await f.store.read(chat)).session.draft.companyUrl).toBe('newer.example')
        expect(controller.saveFailed).toBe(false)
    })

    it('keeps an admitted writer bound to its old scope while a new chat restores', async () => {
        const first = chatOf(), second = chatOf(), f = fixture(), gate = deferred<void>()
        f.ports.save.mockImplementationOnce(async input => { await gate.promise; return f.store.save(input) })
        await render(first, f.ports)
        await act(async () => { controller.set({ companyUrl: 'old.example' }); controller.set({ companyUrl: 'latest-old.example' }) })
        await render(second, f.ports)
        expect(controller.draft.companyUrl).toBe('')
        await act(async () => gate.resolve())
        expect(f.ports.save.mock.calls.every(([input]) => input.chat.chatId === first.chatId)).toBe(true)
        expect((await f.store.read(first)).session.draft.companyUrl).toBe('latest-old.example')
        expect((await f.store.read(second)).session.revision).toBe(0)
        expect(controller.revision).toBe(0)
        expect(controller.error).toBeNull()
    })

    it('saves a final selected role before one StrictMode completion delivery', async () => {
        const chat = chatOf(), f = fixture()
        await render(chat, f.ports, true, true)
        await act(async () => controller.set({ companyUrl: 'strict.example' }))
        await click('Next')
        expect(controller.step).toBe('role')
        const option = document.querySelector<HTMLElement>('[data-hitl="option-0"]')
        expect(option).not.toBeNull()
        await act(async () => option!.click())
        expect(controller.finished).toBe(true)
        expect(f.authority.deliver).toHaveBeenCalledTimes(1)
        expect(f.ports.complete).toHaveBeenCalledTimes(1)
        expect((await f.store.read(chat)).session.draft.position).toBe('Founder / CEO')
        expect(f.ports.complete.mock.calls[0][0].answers.position).toBe('Founder / CEO')
    })

    it('does not finish a new chat when the previous chat completes after a scope change', async () => {
        const first = chatOf(), second = chatOf(), f = fixture(), gate = deferred<void>()
        await f.seed(first)
        f.ports.complete.mockImplementationOnce(async input => { await gate.promise; return f.store.complete(input, f.authority) })
        await render(first, f.ports)
        await act(async () => controller.chooseRole('Founder'))
        expect(controller.submitting).toBe(true)
        await render(second, f.ports)
        await act(async () => gate.resolve())
        expect(controller.finished).toBe(false)
        expect(controller.completion).toBeNull()
        expect(controller.draft.companyUrl).toBe('')
        expect(f.ports.complete.mock.calls[0][0].chat).toEqual(first)
        expect(f.authority.deliver.mock.calls[0][0].chat).toEqual(first)
    })

    it('restores an uncertain completion ID, locks its answers, and recovers only on explicit Retry', async () => {
        const chat = chatOf(), f = fixture()
        const view = await f.seed(chat, { draft: { ...EMPTY_DRAFT, companyUrl: 'retry.example', position: 'Founder' } })
        f.authority.deliver.mockImplementationOnce(async input => { f.deliverRecord(input); throw new Error('Lost delivery acknowledgment.') })
        const requestId = crypto.randomUUID()
        const receipt = await f.store.complete({ chat, requestId, expectedRevision: view.session.revision, answers: toIntake(view.session.draft, 'Ada', null) }, f.authority)
        expect(receipt.state).toBe('uncertain')
        await render(chat, f.ports)
        expect(controller.locked).toBe(true)
        expect(f.ports.complete).not.toHaveBeenCalled()
        await act(async () => controller.set({ companyUrl: 'must-not-replace.example' }))
        expect(controller.draft.companyUrl).toBe('retry.example')
        await click('Retry')
        expect(controller.finished).toBe(true)
        expect(f.ports.complete.mock.calls[0][0].requestId).toBe(requestId)
        expect(f.authority.deliver).toHaveBeenCalledTimes(1)
    })

    it('does not rebase local answers or submit after a conflicting draft save', async () => {
        const chat = chatOf(), f = fixture()
        await f.seed(chat)
        await render(chat, f.ports)
        const saved = (await f.store.read(chat)).session
        await f.store.save({ chat, requestId: crypto.randomUUID(), baseRevision: saved.revision, stepIndex: 1, draft: { ...saved.draft, companyUrl: 'other-view.example' }, decidedIndustry: null, knownFirstName: 'Ada' })
        await act(async () => controller.chooseRole('Founder'))
        expect(controller.conflicted).toBe(true)
        expect(f.ports.complete).not.toHaveBeenCalled()
        expect(controller.draft.companyUrl).toBe('saved.example')
        await click('Reload saved answers')
        expect(controller.draft.companyUrl).toBe('other-view.example')
        expect(controller.saveFailed).toBe(false)
    })

    it('invalidates a classifier as soon as the website changes and never calls a classifier a site read', async () => {
        vi.useFakeTimers()
        const chat = chatOf(), f = fixture(), decision = deferred<TemplateCategory | null>()
        const decideIndustry = vi.fn<NonNullable<DesktopForemanIntakeClientPorts['decideIndustry']>>(() => decision.promise)
        await render(chat, { ...f.ports, decideIndustry })
        await act(async () => controller.set({ companyUrl: 'first.example' }))
        await act(async () => { await vi.advanceTimersByTimeAsync(351) })
        expect(decideIndustry).toHaveBeenCalledTimes(1)
        await act(async () => controller.set({ companyUrl: 'second.example' }))
        expect(decideIndustry.mock.calls[0][1]?.aborted).toBe(true)
        await act(async () => decision.resolve('saas'))
        expect(controller.industry).toBeNull()
        expect(controller.siteRead).toBeNull()
    })

    it('cancels hidden classification and does not restart it merely by reopening', async () => {
        vi.useFakeTimers()
        const chat = chatOf(), f = fixture(), decision = deferred<TemplateCategory | null>()
        const decideIndustry = vi.fn<NonNullable<DesktopForemanIntakeClientPorts['decideIndustry']>>(() => decision.promise)
        const ports = { ...f.ports, decideIndustry }
        await render(chat, ports)
        await act(async () => controller.set({ companyUrl: 'hidden.example' }))
        await act(async () => { await vi.advanceTimersByTimeAsync(351) })
        await render(chat, ports, false)
        expect(decideIndustry.mock.calls[0][1]?.aborted).toBe(true)
        await act(async () => decision.resolve('legal'))
        await render(chat, ports, true)
        await act(async () => { await vi.advanceTimersByTimeAsync(700) })
        expect(decideIndustry).toHaveBeenCalledTimes(1)
        expect(controller.industry).toBeNull()
    })

    it('keeps a rejected site observation unavailable even if classification succeeds', async () => {
        vi.useFakeTimers()
        const chat = chatOf(), f = fixture()
        const decideIndustry = vi.fn(async () => 'saas' as const)
        const analyzeSite = vi.fn(async () => { throw new Error('The site request failed.') })
        await render(chat, { ...f.ports, decideIndustry, analyzeSite })
        await act(async () => controller.set({ companyUrl: 'unread.example' }))
        await act(async () => { await vi.advanceTimersByTimeAsync(351) })
        expect(controller.industry).toBe('saas')
        expect(controller.siteRead).toBeNull()
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('could not read')
    })

    it('drains a save admitted before quit and refuses new edits while shutdown is frozen', async () => {
        const chat = chatOf(), f = fixture(), gate = deferred<void>()
        f.ports.save.mockImplementationOnce(async input => { await gate.promise; return f.store.save(input) })
        await render(chat, f.ports)
        await act(async () => controller.set({ companyUrl: 'admitted.example' }))
        let flushed = false
        let pending!: Promise<boolean>
        await act(async () => { pending = flushDesktopDrafts().then(value => { flushed = true; return value }) })
        expect(isDesktopQuitting()).toBe(true)
        expect(flushed).toBe(false)
        await act(async () => controller.set({ companyUrl: 'too-late.example' }))
        expect(controller.draft.companyUrl).toBe('admitted.example')
        await act(async () => gate.resolve())
        expect(await pending).toBe(true)
        expect(await flushDesktopForemanIntakeWrites()).toBe(true)
        expect((await f.store.read(chat)).session.draft.companyUrl).toBe('admitted.example')
    })

    it('resumes a cancelled read when the user cancels quitting, without any completion effect', async () => {
        const chat = chatOf(), f = fixture(), read = deferred<Awaited<ReturnType<typeof f.ports.read>>>()
        f.ports.read.mockImplementationOnce(() => read.promise)
        await render(chat, f.ports)
        await act(async () => { await flushDesktopDrafts() })
        expect(f.ports.read.mock.calls[0][1]?.aborted).toBe(true)
        await act(async () => cancelDraftShutdown())
        expect(controller.restored).toBe(true)
        await act(async () => read.resolve(await f.store.read(chat)))
        expect(f.ports.complete).not.toHaveBeenCalled()
        expect(f.ports.save).not.toHaveBeenCalled()
    })
})
