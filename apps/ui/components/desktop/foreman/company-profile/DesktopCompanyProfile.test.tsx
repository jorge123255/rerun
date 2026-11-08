// @vitest-environment happy-dom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopCompanyProfileClient } from '@/lib/desktop/company-profile/client'
import type { DesktopCompanyProfileController } from '@/lib/desktop/company-profile/use-desktop-company-profile'
import { profileAttempt, profileChat, profileView } from '@/lib/desktop/company-profile/test-fixtures'
import { DesktopCompanyProfile } from './DesktopCompanyProfile'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren() })
const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label)

function client(): DesktopCompanyProfileClient {
    return {
        read: vi.fn(async () => profileView),
        decide: vi.fn(async () => profileAttempt('decide')),
        enrich: vi.fn(async () => profileAttempt('enrich')),
        cancel: vi.fn(async () => profileAttempt('enrich', 'cancelled')),
    }
}

test('restore starts no analysis; explicit controller calls and correction stay on canonical callbacks', async () => {
    const api = client()
    const controllerRef = createRef<DesktopCompanyProfileController | null>()
    const onCorrection = vi.fn()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCompanyProfile chat={profileChat} client={api} active emptyWorkspace onboarding draftRevision={3} controllerRef={controllerRef} onCorrection={onCorrection} />))
    expect(api.read).toHaveBeenCalledOnce()
    expect(api.decide).not.toHaveBeenCalled()
    expect(api.enrich).not.toHaveBeenCalled()
    await act(async () => { await controllerRef.current!.decide() })
    expect(api.decide).toHaveBeenCalledOnce()
    await act(async () => root!.render(<DesktopCompanyProfile chat={profileChat} client={api} active emptyWorkspace onboarding draftRevision={3} controllerRef={controllerRef} onCorrection={onCorrection} />))
    const unavailable = { ...profileView, enrichment: profileAttempt('enrich', 'unavailable') }
    vi.mocked(api.read).mockResolvedValue(unavailable)
    await act(async () => { await controllerRef.current!.read() })
    await act(async () => button('Review original question')!.click())
    expect(onCorrection).toHaveBeenCalledExactlyOnceWith({ field: 'companyUrl', prompt: 'What is your company website?', preserveOriginalQuestion: true })
})

test('Close releases owned requests without cancelling committed work or starting analysis', async () => {
    const api = client()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCompanyProfile chat={profileChat} client={api} active emptyWorkspace onboarding draftRevision={3} />))
    await act(async () => root!.unmount())
    expect(api.cancel).not.toHaveBeenCalled()
    expect(api.decide).not.toHaveBeenCalled()
    expect(api.enrich).not.toHaveBeenCalled()
})
