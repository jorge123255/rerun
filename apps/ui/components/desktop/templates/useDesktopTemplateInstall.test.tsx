// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopTemplatesClient } from '@/lib/desktop/templates-client'
import { useDesktopTemplateInstall } from './useDesktopTemplateInstall'
import type { DesktopTemplateDetail } from './types'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const template: DesktopTemplateDetail = {
    templateId: 'template-1',
    revision: 'revision-4',
    title: 'Research team',
    tagline: '',
    description: '',
    category: 'other',
    capturedAt: null,
    updatedAt: '2026-11-05T00:00:00.000Z',
    agents: [],
    exclusions: [],
    unsupportedEntries: [],
}
const receipt = { receiptId: 'receipt-1', coworkers: [{ id: 'coworker-1', name: 'Researcher' }] }

let root: Root | undefined
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.restoreAllMocks()
})

function clientWith(install: DesktopTemplatesClient['install']) {
    return { install, currentInstall: vi.fn(async () => ({ status: 'none', templateId: template.templateId, revision: template.revision })), pendingInstall: () => null } as unknown as DesktopTemplatesClient
}

it('calls onInstalled only for an acknowledged receipt and only once per attempt', async () => {
    const install = vi.fn()
        .mockRejectedValueOnce(new Error('acknowledgement unknown'))
        .mockResolvedValue(receipt)
    const onInstalled = vi.fn()
    const client = clientWith(install)
    root = createRoot(document.body.appendChild(document.createElement('div')))
    let api!: ReturnType<typeof useDesktopTemplateInstall>
    function Probe() {
        api = useDesktopTemplateInstall({ client, template, onInstalled })
        return null
    }
    await act(async () => root!.render(<Probe />))

    await act(async () => { await api!.run() })
    expect(onInstalled).not.toHaveBeenCalled()
    expect(api!.error).toContain('acknowledgement unknown')

    await act(async () => { await api!.run() })
    await act(async () => { await api!.run() })
    expect(onInstalled).toHaveBeenCalledTimes(1)
    expect(onInstalled).toHaveBeenCalledWith(receipt)
})

it('resumes the exact interrupted request and gives Use again a separate attempt', async () => {
    const install = vi.fn().mockResolvedValue(receipt)
    const onInstalled = vi.fn()
    const client = clientWith(install)
    const resume = { templateId: template.templateId, revision: template.revision, requestId: '11111111-1111-4111-8111-111111111111' }
    vi.mocked(client.currentInstall).mockResolvedValue({ status: 'pending', ...resume })
    root = createRoot(document.body.appendChild(document.createElement('div')))
    let api!: ReturnType<typeof useDesktopTemplateInstall>
    function Probe() {
        api = useDesktopTemplateInstall({ client, template, resume, onInstalled })
        return null
    }
    await act(async () => root!.render(<Probe />))

    await act(async () => { await api!.run() })
    expect(install.mock.calls[0][1]).toEqual({ requestId: resume.requestId })

    await act(async () => { await api!.again() })
    expect(install.mock.calls[1][1]).toEqual({ again: true })
    expect(onInstalled).toHaveBeenCalledTimes(2)
})

it('publishes the install intent before acknowledgement and clears it after the root callback', async () => {
    let finish!: (value: typeof receipt) => void
    const intent = { templateId: template.templateId, revision: template.revision, requestId: '11111111-1111-4111-8111-111111111111' }
    const client = {
        install: vi.fn(() => new Promise<typeof receipt>(resolve => { finish = resolve })),
        currentInstall: vi.fn(async () => ({ status: 'none', templateId: template.templateId, revision: template.revision })),
        pendingInstall: () => intent,
    } as unknown as DesktopTemplatesClient
    const events: string[] = []
    root = createRoot(document.body.appendChild(document.createElement('div')))
    let api!: ReturnType<typeof useDesktopTemplateInstall>
    function Probe() {
        api = useDesktopTemplateInstall({
            client,
            template,
            onInstalled: () => events.push('installed'),
            onInterrupted: value => events.push(value ? 'pending' : 'cleared'),
        })
        return null
    }
    await act(async () => root!.render(<Probe />))

    await act(async () => { void api.run() })
    expect(events).toEqual(['pending'])
    await act(async () => { finish(receipt) })
    expect(events).toEqual(['pending', 'installed', 'cleared'])
})

it('recovers previous use on remount without installing or navigating and explicitly creates the next copy', async () => {
    const install = vi.fn().mockResolvedValue(receipt)
    const client = clientWith(install)
    const onInstalled = vi.fn()
    vi.mocked(client.currentInstall).mockResolvedValue({ status: 'installed', templateId: template.templateId, revision: template.revision, requestId: 'request-1', receiptId: receipt.receiptId, coworkers: [] })
    let api!: ReturnType<typeof useDesktopTemplateInstall>
    function Probe() { api = useDesktopTemplateInstall({ client, template, onInstalled }); return null }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    expect(api.receipt?.receiptId).toBe(receipt.receiptId)
    expect(install).not.toHaveBeenCalled()
    expect(onInstalled).not.toHaveBeenCalled()
    await act(async () => root!.unmount())
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    await act(async () => api.run())
    expect(install).not.toHaveBeenCalled()
    await act(async () => api.again())
    expect(install).toHaveBeenCalledExactlyOnceWith(template, { again: true })
    expect(onInstalled).toHaveBeenCalledOnce()
})

it('a pending read only offers an explicit retry of the saved attempt', async () => {
    const install = vi.fn().mockResolvedValue(receipt)
    const client = clientWith(install)
    const pending = { status: 'pending' as const, templateId: template.templateId, revision: template.revision, requestId: '11111111-1111-4111-8111-111111111111' }
    vi.mocked(client.currentInstall).mockResolvedValue(pending)
    let api!: ReturnType<typeof useDesktopTemplateInstall>
    function Probe() { api = useDesktopTemplateInstall({ client, template, onInstalled: vi.fn() }); return null }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    expect(api.interrupted).toBe(true)
    expect(install).not.toHaveBeenCalled()
    await act(async () => api.again())
    expect(install).not.toHaveBeenCalled()
    await act(async () => api.run())
    expect(install).toHaveBeenCalledExactlyOnceWith(template, { requestId: pending.requestId })
})

it('failed status lookup retries only the read and cannot accidentally install', async () => {
    const install = vi.fn().mockResolvedValue(receipt)
    const client = clientWith(install)
    vi.mocked(client.currentInstall).mockRejectedValueOnce(new Error('offline'))
    let api!: ReturnType<typeof useDesktopTemplateInstall>
    function Probe() { api = useDesktopTemplateInstall({ client, template, onInstalled: vi.fn() }); return null }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    expect(api.readFailed).toBe(true)
    await act(async () => api.run())
    expect(install).not.toHaveBeenCalled()
    await act(async () => api.refresh())
    expect(api.readFailed).toBe(false)
    expect(install).not.toHaveBeenCalled()
})
