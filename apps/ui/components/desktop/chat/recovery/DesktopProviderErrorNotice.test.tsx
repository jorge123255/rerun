// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { ChatErrorKind } from '@/lib/chat-error'
import { DesktopProviderErrorNotice } from './DesktopProviderErrorNotice'

vi.mock('@rerun/ui', () => ({ BorderBeam: () => null }))
const roots: Root[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

type Handlers = Omit<ComponentProps<typeof DesktopProviderErrorNotice>, 'kind' | 'message'>
async function mount(kind: ChatErrorKind, message: string, handlers: Handlers = {}) {
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    await act(async () => root.render(<DesktopProviderErrorNotice kind={kind} message={message} {...handlers} />))
}

const button = (label: string) => [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].find(item => item.textContent?.includes(label))
const click = async (label: string) => { await act(async () => { button(label)?.click() }) }
const text = () => document.body.textContent ?? ''

test('a missing session offers only a new conversation and never deletes anything itself', async () => {
    const onNewConversation = vi.fn()
    const onRetry = vi.fn()
    await mount('session_gone', 'session not found for this agent', { onNewConversation, onRetry })
    expect(text()).toContain('cannot reach this conversation')
    await click('New conversation')
    expect(onNewConversation).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
})

test('a rejected thinking replay offers retry but no model switch', async () => {
    const onRetry = vi.fn()
    const onSwitchModel = vi.fn()
    await mount('thinking_replay', 'Invalid `signature` in `thinking` block', { onRetry, onSwitchModel })
    await click('Retry')
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(text()).not.toContain('Switch to another model')
    expect(onSwitchModel).not.toHaveBeenCalled()
})

test('run_in_flight offers stop and explains the hold', async () => {
    const onStopRun = vi.fn()
    await mount('run_in_flight', 'run_in_flight', { onStopRun })
    expect(text()).toContain('still holding this conversation')
    await click('Stop run')
    expect(onStopRun).toHaveBeenCalledTimes(1)
})

test('an unauthorized connection offers reconnect', async () => {
    const onReconnect = vi.fn()
    await mount('unauthorized', 'Failed to authenticate. API Error: 401 Invalid bearer token', { onReconnect })
    await click('Reconnect')
    expect(onReconnect).toHaveBeenCalledTimes(1)
})

test('exhausted OpenAI API credits are named and offer a model switch', async () => {
    const onSwitchModel = vi.fn(), onRetry = vi.fn()
    await mount('usage_limit', 'OpenAI API credits used up', { onSwitchModel, onRetry })
    expect(text()).toContain('OpenAI API credits used up')
    expect(text()).toContain('platform.openai.com')
    expect(button('Retry')).toBeUndefined()
    await click('Switch model')
    expect(onSwitchModel).toHaveBeenCalledOnce()
})

test('an OpenAI-compatible endpoint does not inherit OpenAI billing guidance', async () => {
    await mount('usage_limit', 'Provider API credits used up', { onSwitchModel: vi.fn() })
    expect(text()).toContain('Provider API credits used up')
    expect(text()).toContain('Check its billing settings')
    expect(text()).not.toContain('platform.openai.com')
})

test('a refused model opens the conversation model picker', async () => {
    const onSwitchModel = vi.fn()
    await mount('provider_error', 'provider returned error', { onSwitchModel })
    await click('Switch model')
    expect(onSwitchModel).toHaveBeenCalledOnce()
})
