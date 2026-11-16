// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { EMPTY_DRAFT } from '@rerun/contracts'
import type { DesktopIntakeSiteProfile as SiteProfile } from '@/lib/desktop/foreman-intake/site-profile'
import { DesktopIntakeSiteProfile } from './DesktopIntakeSiteProfile'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren() })

const chat = { workspaceId: '1', chatId: 'fmc_sitecard0001' }
const profile: SiteProfile = { website: 'retalk.example', readAt: '2026-11-06T00:00:00.000Z', name: 'Retalk', description: 'Customer research software', offering: 'Research interviews and analysis', audience: 'Support teams' }
type Intake = Parameters<typeof DesktopIntakeSiteProfile>[0]['intake']
const intakeOf = (patch: Partial<Intake> = {}): Intake => ({ draft: { ...EMPTY_DRAFT, companyUrl: 'retalk.example' }, siteRead: null, restored: true, finished: false, ...patch })
const card = () => document.querySelector('[data-intake-site-profile]')
async function render(intake: Intake, read: (...args: never[]) => Promise<SiteProfile | null>, active = true) {
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopIntakeSiteProfile chat={chat} intake={intake} active={active} read={read as never} />))
}

it('shows what was read, marked as coming from their website, when the saved intake is reopened', async () => {
    const read = vi.fn(async () => profile)
    await render(intakeOf(), read)
    expect(read).toHaveBeenCalledOnce()
    expect(read.mock.calls[0]![0 as never]).toEqual(chat)
    expect(card()?.getAttribute('aria-label')).toBe('Read from your website')
    for (const text of ['Read from your website', 'retalk.example', 'Retalk', 'Customer research software', 'What you sell', 'Research interviews and analysis', 'Who you sell to', 'Support teams', 'your answer wins']) {
        expect(card()?.textContent).toContain(text)
    }
})

it('reads again when the website read finishes, and shows nothing before then', async () => {
    let answer: SiteProfile | null = null
    const read = vi.fn(async () => answer)
    await render(intakeOf({ siteRead: 'reading' }), read)
    expect(card()).toBeNull()
    answer = profile
    await render(intakeOf({ siteRead: 'ready' }), read)
    expect(read).toHaveBeenCalledTimes(2)
    expect(card()?.textContent).toContain('Retalk')
})

it('hides the card once the website in the answers is no longer the one that was read', async () => {
    const read = vi.fn(async () => profile)
    await render(intakeOf(), read)
    expect(card()).not.toBeNull()
    await render(intakeOf({ draft: { ...EMPTY_DRAFT, companyUrl: 'other.example' } }), read)
    expect(card()).toBeNull()
    await render(intakeOf({ draft: { ...EMPTY_DRAFT, companyUrl: 'retalk.example', websiteSkipped: true } }), read)
    expect(card()).toBeNull()
    expect(read).toHaveBeenCalledOnce()
})

it('asks for nothing while hidden, before restore or without a website, and a failed read leaves the questions alone', async () => {
    const read = vi.fn(async () => profile)
    await render(intakeOf(), read, false)
    await render(intakeOf({ restored: false }), read)
    await render(intakeOf({ draft: EMPTY_DRAFT }), read)
    expect(read).not.toHaveBeenCalled()
    expect(card()).toBeNull()
    const failing = vi.fn(async () => { throw new Error('offline') })
    await render(intakeOf(), failing)
    expect(failing).toHaveBeenCalledOnce()
    expect(card()).toBeNull()
})

it('page text is rendered as text, never as markup, and the card leaves once the intake is finished', async () => {
    const read = vi.fn(async () => ({ ...profile, description: '<img src=x onerror=alert(1)> <b>bold</b>' }))
    await render(intakeOf(), read)
    expect(card()?.querySelector('img, b')).toBeNull()
    expect(card()?.textContent).toContain('<img src=x onerror=alert(1)>')
    await render(intakeOf({ finished: true }), read)
    expect(card()).toBeNull()
})
