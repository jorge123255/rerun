// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EMPTY_DRAFT, type DesktopGithubProject } from '@rerun/contracts'
import type { DesktopIntakeGithubController } from '@/lib/desktop/foreman-intake/use-desktop-intake-github'
import type { DesktopIntakeSiteProfile as SiteProfile } from '@/lib/desktop/foreman-intake/site-profile'
import { resetDesktopArrivalsForTest } from '../../panel-motion/DesktopArrive'
import { DesktopIntakeGithubProjects } from './DesktopIntakeGithubProjects'
import { DesktopIntakeSiteProfile } from './DesktopIntakeSiteProfile'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
beforeEach(() => { resetDesktopArrivalsForTest() })
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren() })

const project = (name: string): DesktopGithubProject => ({
    id: `acme/${name}`, owner: 'acme', name, url: `https://github.com/acme/${name}`, state: 'read', failure: null, kind: 'web-app', kindSource: 'manifest',
    purpose: `What ${name} is for`, stack: ['TypeScript'], build: null, suggestedRoles: [], roles: [], removed: false,
} as unknown as DesktopGithubProject)
const github = (patch: Record<string, unknown>) => ({ record: null, reading: false, count: 2, dirty: false, edit: vi.fn(), analyze: vi.fn(), ...patch }) as unknown as DesktopIntakeGithubController
const record = (names: string[]) => ({ projects: names.map(project), links: [], inferenceNote: null })
const intake = { restored: true, finished: false }
async function renderProjects(controller: DesktopIntakeGithubController) {
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopIntakeGithubProjects github={controller} intake={intake} />))
}
const projects = () => [...document.querySelectorAll<HTMLElement>('[data-intake-github-project]')]

it('shows the project cards of a saved intake settled when it is reopened', async () => {
    await renderProjects(github({ record: record(['web', 'api']) }))
    expect(projects().map(card => [card.tagName, card.dataset.desktopArrive])).toEqual([['LI', 'settled'], ['LI', 'settled']])
    for (const card of projects()) { expect(card.className).not.toContain('animate-in'); expect(card.style.animationDelay).toBe('') }
})

it('slides the cards in one after another when a read the person watched finishes, and keeps their controls', async () => {
    await renderProjects(github({ reading: true }))
    expect(document.body.textContent).toContain('Reading 2 repositories from GitHub')
    expect(projects()).toEqual([])
    await renderProjects(github({ record: record(['web', 'api', 'docs']) }))
    expect(projects().map(card => card.dataset.desktopArrive)).toEqual(['live', 'live', 'live'])
    expect(projects().map(card => card.style.animationDelay)).toEqual(['', '60ms', '120ms'])
    for (const card of projects()) expect(card.classList.contains('motion-reduce:animate-none')).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Remove web"]')!.disabled).toBe(false)
    expect(document.querySelector('select[aria-label="Kind of web"]')).not.toBeNull()
    // Read again: the same repositories do not slide in a second time.
    await renderProjects(github({ reading: true, record: null }))
    await renderProjects(github({ record: record(['web', 'api', 'docs']) }))
    expect(projects().map(card => card.dataset.desktopArrive)).toEqual(['settled', 'settled', 'settled'])
})

const chat = { workspaceId: '1', chatId: 'fmc_sitearrive01' }
const profile: SiteProfile = { website: 'retalk.example', readAt: '2026-11-06T00:00:00.000Z', name: 'Retalk', description: 'Customer research software', offering: 'Research interviews and analysis', audience: 'Support teams' }
type Intake = Parameters<typeof DesktopIntakeSiteProfile>[0]['intake']
const intakeOf = (patch: Partial<Intake> = {}): Intake => ({ draft: { ...EMPTY_DRAFT, companyUrl: 'retalk.example' }, siteRead: null, restored: true, finished: false, ...patch })
async function renderSite(value: Intake, read: () => Promise<SiteProfile | null>) {
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopIntakeSiteProfile chat={chat} intake={value} read={read as never} />))
}
const site = () => document.querySelector<HTMLElement>('[data-intake-site-profile]')

it('shows the website card of a saved intake settled when it is reopened', async () => {
    await renderSite(intakeOf(), async () => profile)
    expect(site()!.dataset.desktopArrive).toBe('settled')
    expect(site()!.tagName).toBe('SECTION')
    expect(site()!.getAttribute('aria-label')).toBe('Read from your website')
})

it('slides the website card in when the read the person watched finishes', async () => {
    let answer: SiteProfile | null = null
    const read = async () => answer
    await renderSite(intakeOf({ siteRead: 'reading' }), read)
    expect(site()).toBeNull()
    answer = profile
    await renderSite(intakeOf({ siteRead: 'ready' }), read)
    expect(site()!.dataset.desktopArrive).toBe('live')
    expect(site()!.classList.contains('motion-reduce:animate-none')).toBe(true)
    expect(site()!.textContent).toContain('Retalk')
})
