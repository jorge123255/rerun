// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { useDesktopClaudePlan, type DesktopClaudePlanAttempt, type DesktopClaudePlanRuntime } from './use-desktop-claude-plan'

const roots: Root[] = []
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.restoreAllMocks()
})
const attempt = (phase: DesktopClaudePlanAttempt['phase'], patch: Partial<DesktopClaudePlanAttempt> = {}): DesktopClaudePlanAttempt => ({ attemptId: 'attempt-1', phase, ...(phase === 'waiting' ? { authorizeUrl: 'https://claude.ai/oauth/authorize?state=opaque' } : {}), ...patch })

function runtimeWith(overrides: Partial<DesktopClaudePlanRuntime> = {}): DesktopClaudePlanRuntime {
    return {
        start: vi.fn(async () => attempt('waiting')),
        reconcile: vi.fn(async () => attempt('waiting')),
        submit: vi.fn(async () => attempt('connected')),
        cancel: vi.fn(async () => attempt('idle')),
        ...overrides,
    }
}

async function mount(runtime: DesktopClaudePlanRuntime, onOpenAuthorization = vi.fn()) {
    let value!: ReturnType<typeof useDesktopClaudePlan>
    function Harness() {
        value = useDesktopClaudePlan({ runtime, onOpenAuthorization })
        return <span>{value.phase}</span>
    }
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    await act(async () => root.render(<Harness />))
    return { get value() { return value }, root }
}

test('repeated Open clicks create one durable attempt and one explicit browser open', async () => {
    let resolve!: (value: DesktopClaudePlanAttempt) => void
    const runtime = runtimeWith({ start: vi.fn(() => new Promise<DesktopClaudePlanAttempt>(done => { resolve = done })) })
    const onOpenAuthorization = vi.fn()
    const hook = await mount(runtime, onOpenAuthorization)
    await act(async () => { void hook.value.start(); void hook.value.start() })
    expect(runtime.start).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(attempt('waiting')) })
    expect(onOpenAuthorization).toHaveBeenCalledExactlyOnceWith('https://claude.ai/oauth/authorize?state=opaque')
    expect(hook.value.phase).toBe('waiting')
})

test('restart reconciles the same attempt and submit connects without another login', async () => {
    const runtime = runtimeWith()
    const hook = await mount(runtime)
    await act(async () => { await hook.value.reconcile() })
    expect(hook.value.attemptId).toBe('attempt-1')
    await act(async () => { await hook.value.submit('  opaque-code  ') })
    expect(runtime.submit).toHaveBeenCalledWith('attempt-1', 'opaque-code', expect.any(AbortSignal))
    expect(runtime.start).not.toHaveBeenCalled()
    expect(hook.value.phase).toBe('connected')
})

test('a stale submit cannot overwrite a newer attempt or cancel result', async () => {
    let resolveOld!: (value: DesktopClaudePlanAttempt) => void
    const runtime = runtimeWith({
        submit: vi.fn(() => new Promise<DesktopClaudePlanAttempt>(done => { resolveOld = done })),
        start: vi.fn(async () => attempt('waiting', { attemptId: 'attempt-2' })),
    })
    const hook = await mount(runtime)
    await act(async () => { await hook.value.start() })
    await act(async () => { void hook.value.submit('old-code') })
    await act(async () => { await hook.value.cancel() })
    await act(async () => { await hook.value.start() })
    await act(async () => { resolveOld(attempt('connected')) })
    expect(hook.value.attemptId).toBe('attempt-2')
    expect(hook.value.phase).toBe('waiting')
})

test('Cancel closes only the UI attempt and invalid runtime links are refused', async () => {
    const runtime = runtimeWith({ start: vi.fn(async () => attempt('waiting', { authorizeUrl: 'https://attacker.example' })) })
    const onOpenAuthorization = vi.fn()
    const hook = await mount(runtime, onOpenAuthorization)
    await act(async () => { await hook.value.start() })
    expect(onOpenAuthorization).not.toHaveBeenCalled()
    expect(hook.value.error).toContain('sign-in')
    await act(async () => { await hook.value.cancel() })
    expect(runtime.cancel).toHaveBeenCalledWith('attempt-1', expect.any(AbortSignal))
    expect(hook.value.phase).toBe('idle')
})
