// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { BoxConnection } from '@/lib/engine/types'
import { DesktopClaudeConnectionDetails } from './DesktopClaudeConnectionDetails'

vi.mock('@/components/connections/ModelBuckets', () => ({
    ModelBuckets: ({ connection, onModelsChange }: { connection: BoxConnection; onModelsChange: (models: string[]) => void }) => <div><span>{connection.models.join(',')}</span><button onClick={() => onModelsChange(['claude-opus-5-5'])}>Choose catalog model</button></div>,
}))
vi.mock('@/components/connections/plan-connect/ForemanTrack', () => ({ ForemanTrack: ({ steps }: { steps: { title: string }[] }) => <ol>{steps.map((step, index) => <li key={index}>{step.title}</li>)}</ol> }))
const roots: Root[] = []
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.restoreAllMocks()
})
const connection = (patch: Partial<BoxConnection> = {}): BoxConnection => ({
    id: 'claude-1', name: 'Claude work', provider: 'claude', models: ['claude-opus-5-5'], extraModels: [], connected: true, credentialRejected: false, ...patch,
})

async function mount(current: BoxConnection, onDisconnect = vi.fn()) {
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    await act(async () => root.render(<DesktopClaudeConnectionDetails
        connection={current} account={{ label: 'person@example.com' }} defaultModel={null}
        runtime={{ start: vi.fn(), reconcile: vi.fn(), submit: vi.fn(), cancel: vi.fn() }}
        onOpenAuthorization={vi.fn()} onModelsChange={vi.fn()} onDisconnect={onDisconnect} onBack={vi.fn()}
    />))
    return { onDisconnect }
}

test('shows connected account metadata and runtime catalog models with explicit removal confirmation', async () => {
    const { onDisconnect } = await mount(connection())
    expect(document.body.textContent).toContain('Connected')
    expect(document.body.textContent).toContain('person@example.com')
    expect(document.body.textContent).toContain('claude-opus-5-5')
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Remove Claude work'))!.click() })
    expect(document.body.textContent).toContain('Remove Claude work?')
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Remove')!.click() })
    expect(onDisconnect).toHaveBeenCalledWith('claude-1')
})

test('expired sign-in offers the original reconnect flow without clearing the saved account', async () => {
    await mount(connection({ connected: false }))
    expect(document.body.textContent).toContain('This sign-in expired.')
    expect(document.body.textContent).toContain('Open Claude')
    expect(document.body.textContent).toContain('person@example.com')
})

test('rejected and unavailable states are truthful and keep removal available', async () => {
    await mount(connection({ credentialRejected: true }))
    expect(document.body.textContent).toContain('This sign-in was rejected.')
    expect(document.body.textContent).toContain('Remove Claude work')
})
