// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

const service = vi.hoisted(() => {
    const details = vi.fn()
    const dispose = vi.fn()
    return { details, dispose }
})
vi.mock('@/lib/desktop/services-client', () => ({
    createDesktopServicesClient: () => ({ details: service.details, dispose: service.dispose }),
}))

import { DesktopNeedsAuthCard, DesktopSetupCompleteCard } from './DesktopSetupEventCards'
import type { DesktopServiceDetails } from '@/lib/desktop/services-client'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: { root: Root; host: HTMLElement }[] = []
afterEach(() => {
    for (const { root, host } of roots.splice(0)) {
        act(() => root.unmount())
        host.remove()
    }
    service.details.mockReset()
    service.dispose.mockReset()
})

function render(node: React.ReactNode) {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    act(() => root.render(node))
    return host
}

function details(status: 'active' | 'needs_auth'): DesktopServiceDetails {
    return {
        key: 'slack', slug: 'slack', name: 'Slack', category: 'work', summary: '', description: '', icon: null,
        installed: status === 'active', installStatus: status, multiInstance: false, instances: [], installation: null,
        localLimitations: '', authMethods: [], methodAvailability: [],
    }
}

it('renders completion without inventing automatic activation', () => {
    const host = render(<DesktopSetupCompleteCard agentName="Ada" summary="Ready." schedules={[]} triggers={[]} />)
    expect(host.textContent).toContain('Ada is set up')
    expect(host.textContent).toContain('Ready.')
    expect(host.textContent).not.toContain('schedule')
    expect(host.textContent).not.toContain('trigger')
})

it('opens the existing local Apps flow instead of mounting a credential form', async () => {
    service.details.mockResolvedValue(details('needs_auth'))
    const onOpenApps = vi.fn(async () => {})
    const host = render(<DesktopNeedsAuthCard agentId="agent" slug="slack" name="Slack" onOpenApps={onOpenApps} />)
    await act(async () => {})
    expect(host.querySelector('input')).toBeNull()
    const signIn = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Sign in'))!
    await act(async () => { signIn.click() })
    expect(onOpenApps).toHaveBeenCalledWith({ agentId: 'agent', slug: 'slack' })
    expect(service.details).toHaveBeenCalledTimes(2)
})

it('reports local Apps navigation failure without claiming a connection', async () => {
    service.details.mockResolvedValue(details('needs_auth'))
    const host = render(<DesktopNeedsAuthCard agentId="agent" slug="slack" name="Slack" onOpenApps={async () => { throw new Error('Apps unavailable') }} />)
    await act(async () => {})
    const signIn = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Sign in'))!
    await act(async () => { signIn.click() })
    expect(host.textContent).toContain('Apps unavailable')
    expect(host.textContent).not.toContain('Connected')
})
