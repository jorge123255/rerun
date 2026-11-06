// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'
import { profileAttempt, profileChat, profileView } from '@/lib/desktop/company-profile/test-fixtures'
import { DesktopCompanyProfileBoardPreview } from './DesktopCompanyProfileBoardPreview'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren() })
const scope = { ...profileChat, active: true, emptyWorkspace: true, onboarding: true }
async function render(view = profileView, compact = false) {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCompanyProfileBoardPreview scope={scope} view={view} compact={compact} />))
}

test('manual industry choice draws the original tentative Boxes without analysis or coworkers', async () => {
    const profile = { ...profileView.profile, industry: { value: 'ecommerce' as const, origin: 'manual' as const, confidence: 1, evidence: [] } }
    await render({ ...profileView, decision: null, enrichment: null, profile })
    expect(document.body.textContent).toContain('Store')
    expect(document.body.textContent).toContain('Customer Care')
    expect(document.body.textContent).not.toContain('Looking into')
    expect(document.querySelectorAll('[data-agent-id], [data-tile-id]').length).toBe(0)
})

test('sourced name, description, offering, audience, industry and citations use original findings style', async () => {
    await render()
    for (const text of ['Retalk', 'Customer research software', 'Research interviews and analysis', 'Support teams', 'SaaS', '82% confidence']) {
        expect(document.body.textContent).toContain(text)
    }
    expect(document.body.textContent).toContain('Found you')
    expect(document.body.textContent).toContain('What you sell')
    expect(document.body.textContent).toContain('Who you sell to')
    expect(document.body.textContent).toContain('Retalk builds customer research software for support teams.')
    expect(document.querySelector('a[href="https://retalk.example/about"]')).toBeTruthy()
})

test('pending and cancelled outcomes remain truthful and compact keeps one finding', async () => {
    await render({ ...profileView, enrichment: profileAttempt('enrich', 'pending') }, true)
    expect(document.body.textContent).toContain('Reading the public website…')
    expect(document.body.textContent).toContain('Stop analysis')
    expect(document.body.textContent).not.toContain('What you sell')
    await act(async () => root!.unmount())
    document.body.replaceChildren()
    await render({ ...profileView, enrichment: profileAttempt('enrich', 'cancelled') }, true)
    expect(document.body.textContent).toContain('Company analysis stopped.')
    expect(document.body.textContent).toContain('Try again')
    expect(document.body.textContent).not.toContain('Reading the public website…')
})
