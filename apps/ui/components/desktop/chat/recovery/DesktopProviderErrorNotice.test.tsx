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

type Handlers = Partial<Omit<ComponentProps<typeof DesktopProviderErrorNotice>, 'kind' | 'message' | 'agentId' | 'sessionId'>>
async function mount(kind: ChatErrorKind, message: string, handlers: Handlers = {}, sessionId: string | null = 'session-1') {
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    await act(async () => root.render(
        <DesktopProviderErrorNotice kind={kind} message={message} agentId="agent-1" sessionId={sessionId}
            onRetry={handlers.onRetry} onContinue={handlers.onContinue} onStopRun={handlers.onStopRun}
            onNewConversation={handlers.onNewConversation} onReconnect={handlers.onReconnect}
            onSwitchModel={handlers.onSwitchModel} onConversationChoice={handlers.onConversationChoice}
            onOpenModelSettings={handlers.onOpenModelSettings} onModelSaved={handlers.onModelSaved} />,
    ))
    return root
}

const button = (label: string) => [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].find(item => item.textContent?.includes(label))
const click = async (label: string) => { await act(async () => { button(label)?.click() }) }
const text = () => document.body.textContent ?? ''

const modelView = {
    catalog: [{ connectionId: 'conn-1', name: 'ChatGPT', provider: 'codex', models: [{ id: 'gpt-5', label: 'GPT-5' }, { id: 'gpt-5-mini', label: 'GPT-5 mini' }] }],
    workspace: null,
    coworker: { connectionId: 'conn-1', provider: 'codex', model: 'gpt-5', label: 'GPT-5', available: true },
    conversation: null,
    effective: { source: 'coworker', connectionId: 'conn-1', provider: 'codex', name: 'ChatGPT', model: 'gpt-5', label: 'GPT-5', available: true },
}

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
    await click('Switch')
    expect(onSwitchModel).toHaveBeenCalledOnce()
})

test('an OpenAI-compatible endpoint does not inherit OpenAI billing guidance', async () => {
    await mount('usage_limit', 'Provider API credits used up', { onSwitchModel: vi.fn() })
    expect(text()).toContain('Provider API credits used up')
    expect(text()).toContain('Check its billing settings')
    expect(text()).not.toContain('platform.openai.com')
})

test('a refused model opens the recovery picker and saves a conversation-scoped pick', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (init?.method === 'PATCH') {
            expect(JSON.parse(String(init.body))).toEqual({ action: 'conversation', sessionId: 'session-1', connectionId: 'conn-1', model: 'gpt-5-mini' })
            return new Response(JSON.stringify(modelView), { status: 200 })
        }
        return new Response(JSON.stringify(modelView), { status: 200 })
    })
    vi.stubGlobal('fetch', fetcher)
    const onModelSaved = vi.fn()
    const onConversationChoice = vi.fn()
    await mount('provider_error', 'provider returned error', { onModelSaved, onConversationChoice })
    await click('Switch model')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(text()).toContain('GPT-5 mini')
    await click('GPT-5 mini')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(onModelSaved).toHaveBeenCalledTimes(1)
    expect(onConversationChoice).not.toHaveBeenCalled()
})

test('an unsent conversation routes the pick through onConversationChoice instead of patching', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(modelView), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const onConversationChoice = vi.fn()
    const onModelSaved = vi.fn()
    await mount('generic', 'socket hangup', { onConversationChoice, onModelSaved }, null)
    await click('Switch model')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    await click('GPT-5 mini')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(onConversationChoice).toHaveBeenCalledWith({ connectionId: 'conn-1', model: 'gpt-5-mini' })
    expect(onModelSaved).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0)
})
