// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopApprovalAnswer, DesktopPendingApproval } from '@/lib/desktop/approvals'
import { DesktopApprovalCard } from './DesktopApprovalCard'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Keep the actual form state and handlers. Native animation cancellation in happy-dom rejects
// finished promises on unmount, so motion elements become ordinary DOM in this behavior suite.
vi.mock('motion/react', async original => {
    const actual = await original<typeof import('motion/react')>()
    const { createElement, forwardRef } = await import('react')
    const plain = (tag: string) => forwardRef<HTMLElement, Record<string, unknown>>(({ children, ...props }, ref) =>
        createElement(tag, { ...Object.fromEntries(Object.entries(props).filter(([name]) => !actual.isValidMotionProp(name))), ref }, children as ReactNode))
    const elements = new Map<string, ReturnType<typeof plain>>()
    const element = (tag: string) => {
        if (!elements.has(tag)) elements.set(tag, plain(tag))
        return elements.get(tag)!
    }
    return { ...actual,
        AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
        motion: new Proxy(actual.motion, { get(target, key, receiver) {
            if (key === 'create') return (tag: unknown) => typeof tag === 'string' ? element(tag) : tag
            return typeof key === 'string' && key !== 'then' ? element(key) : Reflect.get(target, key, receiver)
        } }),
    }
})

const approval: DesktopPendingApproval = {
    id: 'a'.repeat(64), messageId: 'approval-message', toolCallId: 'approval-call',
    approvals: [{ action: 'Send the prepared message', detail: 'To: teammate@example.test\nHello there.' }],
}
const requestId = 'd04a4023-95c0-4cff-b380-69faec305b14'
const roots: Root[] = []

function mount() {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    roots.push(root)
    return root
}

async function click(selector: string) {
    const button = document.querySelector<HTMLButtonElement>(selector)
    expect(button).not.toBeNull()
    await act(async () => { button!.click() })
}

async function note(value: string) {
    const textarea = document.querySelector('textarea')!
    expect(textarea).not.toBeNull()
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value)
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
}

afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => { root.unmount() })
    document.body.innerHTML = ''
    vi.restoreAllMocks()
})

test('uses the original approval action and details, strips client labels and submits only once', async () => {
    let finish!: () => void
    const onDecide = vi.fn((_payload: DesktopApprovalAnswer) => new Promise<void>(resolve => { finish = resolve }))
    const root = mount()
    await act(async () => { root.render(<DesktopApprovalCard approval={approval} onDecide={onDecide} />) })
    expect(document.body.textContent).toContain('Approval required')
    expect(document.body.textContent).toContain(approval.approvals[0].action)
    expect(document.querySelector('code')?.textContent).toBe(approval.approvals[0].detail)
    const approve = document.querySelector<HTMLButtonElement>('[data-hitl="approve"]')!
    await act(async () => { approve.click(); approve.click() })
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ approvalId: approval.id, requestId: expect.any(String), decisions: [{ decision: 'approved' }] })
    expect(document.querySelector('[data-hitl]')).toBeNull()
    await act(async () => { finish() })
    expect(document.body.textContent).toContain('Decisions sent.')
    expect(document.querySelector('button')?.disabled).toBe(true)
})

test.each(['  Please check the recipient first.  ', ' \n '])('gives a reason through Explain and canonicalizes its optional note: %j', async value => {
    const onDecide = vi.fn(async (_payload: DesktopApprovalAnswer) => {})
    const root = mount()
    await act(async () => { root.render(<DesktopApprovalCard approval={approval} onDecide={onDecide} />) })
    await click('[data-hitl="explain"]')
    expect(document.querySelector('textarea')?.placeholder).toBe('Why not? (optional)')
    await note(value)
    await click('[data-hitl="confirm-decline"]')
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ approvalId: approval.id, requestId: expect.any(String),
        decisions: [{ decision: 'declined', ...(value.trim() && { note: value.trim() }) }] })
})

test('a multi-action batch sends one ordered decision array only after every original step is answered', async () => {
    const batch = { ...approval, approvals: [...approval.approvals, { action: 'Publish the draft', detail: '# Draft' }] }
    const onDecide = vi.fn(async (_payload: DesktopApprovalAnswer) => {})
    const root = mount()
    await act(async () => { root.render(<DesktopApprovalCard approval={batch} onDecide={onDecide} />) })
    await click('[data-hitl="approve"]')
    expect(onDecide).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Publish the draft')
    await click('[data-hitl="explain"]')
    await note('  Wait for review.  ')
    await click('[data-hitl="confirm-decline"]')
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ approvalId: approval.id, requestId: expect.any(String), decisions: [
        { decision: 'approved' }, { decision: 'declined', note: 'Wait for review.' },
    ] })
})

test('an overlong decline note never sends or becomes immutable and leaves the original form usable', async () => {
    const onDecide = vi.fn(async (_payload: DesktopApprovalAnswer) => {})
    const root = mount()
    await act(async () => { root.render(<DesktopApprovalCard approval={approval} onDecide={onDecide} />) })
    await click('[data-hitl="explain"]')
    await note('x'.repeat(20_001))
    await click('[data-hitl="confirm-decline"]')
    expect(onDecide).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('20,000 characters')
    expect(document.body.textContent).not.toContain('Retry decisions')
    expect(document.querySelector<HTMLButtonElement>('[data-hitl="approve"]')?.disabled).toBe(false)
    await click('[data-hitl="explain"]')
    await note('A shorter reason.')
    await click('[data-hitl="confirm-decline"]')
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ approvalId: approval.id, requestId: expect.any(String), decisions: [{ decision: 'declined', note: 'A shorter reason.' }] })
    expect(document.querySelector('[role="alert"]')).toBeNull()
})

test('a failed submit shows immutable decisions and retries the same UUID behind its own duplicate latch', async () => {
    let finish!: () => void
    const onDecide = vi.fn((_payload: DesktopApprovalAnswer) => new Promise<void>(resolve => { finish = resolve }))
        .mockRejectedValueOnce(new Error('Could not confirm decisions'))
    const root = mount()
    await act(async () => { root.render(<DesktopApprovalCard approval={approval} onDecide={onDecide} />) })
    await click('[data-hitl="explain"]')
    await note('Check first.')
    await click('[data-hitl="confirm-decline"]')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Could not confirm decisions')
    expect(document.querySelector('[data-hitl]')).toBeNull()
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.body.textContent).toContain('Check first.')
    const first = onDecide.mock.calls[0][0]
    const retry = document.querySelector('button')!
    expect(retry.textContent).toBe('Retry decisions')
    await act(async () => { retry.click(); retry.click() })
    expect(onDecide).toHaveBeenCalledTimes(2)
    expect(onDecide.mock.calls[1][0]).toEqual(first)
    await act(async () => { finish() })
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(retry.disabled).toBe(true)
})

test('a restored attempt shows safe authoritative text and retries the exact persisted decisions', async () => {
    const saved: DesktopPendingApproval = { ...approval,
        approvals: [{ action: '<img src=x onerror=alert(1)>', detail: '<script>doNotRun()</script>' }],
        attempt: { requestId, decisions: [{ decision: 'declined', note: '<b>Review first</b>' }] },
    }
    const onDecide = vi.fn(async (_payload: DesktopApprovalAnswer) => {})
    const root = mount()
    await act(async () => { root.render(<DesktopApprovalCard approval={saved} onDecide={onDecide} />) })
    expect(document.body.textContent).toContain(saved.approvals[0].action)
    expect(document.querySelector('code')?.textContent).toBe(saved.approvals[0].detail)
    expect(document.body.textContent).toContain('<b>Review first</b>')
    expect(document.querySelector('img,script,b')).toBeNull()
    expect(document.querySelector('[data-hitl]')).toBeNull()
    await click('button')
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ ...saved.attempt, approvalId: saved.id })
})

test('latest disabled state blocks both original decisions and recovery retry', async () => {
    const onDecide = vi.fn(async (_payload: DesktopApprovalAnswer) => {})
    const root = mount()
    await act(async () => { root.render(<DesktopApprovalCard approval={approval} onDecide={onDecide} />) })
    await act(async () => { root.render(<DesktopApprovalCard approval={approval} disabled onDecide={onDecide} />) })
    await click('[data-hitl="approve"]')
    await click('[data-hitl="decline"]')
    const saved: DesktopPendingApproval = { ...approval, attempt: { requestId, decisions: [{ decision: 'approved' }] } }
    await act(async () => { root.render(<DesktopApprovalCard approval={saved} disabled onDecide={onDecide} />) })
    await click('button')
    expect(onDecide).not.toHaveBeenCalled()
    await act(async () => { root.render(<DesktopApprovalCard approval={saved} onDecide={onDecide} />) })
    await click('button')
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ ...saved.attempt, approvalId: saved.id })
})

test('a late rejection from a previous batch cannot unlock or put an error on a newer pending decision', async () => {
    let rejectOld!: (cause: Error) => void
    let finishNew!: () => void
    const onOld = vi.fn((_payload: DesktopApprovalAnswer) => new Promise<void>((_resolve, reject) => { rejectOld = reject }))
    const onNew = vi.fn((_payload: DesktopApprovalAnswer) => new Promise<void>(resolve => { finishNew = resolve }))
    const root = mount()
    await act(async () => { root.render(<DesktopApprovalCard approval={approval} onDecide={onOld} />) })
    await click('[data-hitl="approve"]')
    const next: DesktopPendingApproval = { ...approval, id: 'b'.repeat(64), messageId: 'new-message', toolCallId: 'new-call', approvals: [{ action: 'A different action' }] }
    await act(async () => { root.render(<DesktopApprovalCard approval={next} onDecide={onNew} />) })
    await click('[data-hitl="approve"]')
    await act(async () => { rejectOld(new Error('Old batch failed')) })
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.querySelector('button')?.disabled).toBe(true)
    await click('button')
    expect(onNew).toHaveBeenCalledTimes(1)
    expect(onNew.mock.calls[0][0].approvalId).toBe(next.id)
    expect(onNew.mock.calls[0][0].requestId).not.toBe(onOld.mock.calls[0][0].requestId)
    await act(async () => { finishNew() })
    expect(document.body.textContent).toContain('Decisions sent.')
})
