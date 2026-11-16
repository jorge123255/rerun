// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopGithubProject } from '@rerun/contracts'
import type { DesktopIntakeGithubController } from '@/lib/desktop/foreman-intake/use-desktop-intake-github'
import { resetDesktopArrivalsForTest } from '../panel-motion/DesktopArrive'
import { DesktopForemanGithubProjects } from './DesktopForemanGithubProjects'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
beforeEach(() => { resetDesktopArrivalsForTest() })
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren() })

const project = (name: string, patch: Partial<DesktopGithubProject> = {}): DesktopGithubProject => ({
    id: `acme/${name}`, owner: 'acme', name, url: `https://github.com/acme/${name}`, state: 'read', failure: null, kind: 'web-app', kindSource: 'manifest',
    purpose: `What ${name} is for`, stack: ['TypeScript'], build: null, suggestedRoles: ['developer'], roles: ['developer'], removed: false, ...patch,
})
const github = (projects: DesktopGithubProject[] | null) => ({
    record: projects && { projects, links: [], inferenceNote: null }, reading: false, count: projects?.length ?? 0, dirty: false, error: null, edit: vi.fn(), analyze: vi.fn(),
}) as unknown as DesktopIntakeGithubController
async function render(controller: DesktopIntakeGithubController) {
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopForemanGithubProjects github={controller} />))
}
const toggle = () => document.querySelector<HTMLButtonElement>('[data-foreman-github-toggle]')

it('shows nothing for a conversation with no projects', async () => {
    await render(github(null))
    expect(document.querySelector('[data-foreman-github-projects]')).toBeNull()
    await render(github([project('gone', { removed: true })]))
    expect(document.querySelector('[data-foreman-github-projects]')).toBeNull()
})

it('says how many were read and opens the review with its controls', async () => {
    const controller = github([project('openflix'), project('secret', { state: 'unavailable', failure: 'not_found' })])
    await render(controller)
    expect(toggle()!.textContent).toContain('1 of 2 GitHub projects read')
    expect(toggle()!.textContent).toContain('openflix, secret')
    expect(document.querySelector('[data-intake-github-project]')).toBeNull()
    await act(async () => toggle()!.click())
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelectorAll('[data-intake-github-project]')).toHaveLength(2)
    expect(document.querySelector('[data-intake-github-unread]')!.textContent).toContain('sign in to GitHub in the Vault')
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Remove openflix"]')!.click())
    expect(controller.edit).toHaveBeenCalledWith({ type: 'remove-repository', id: 'acme/openflix' })
})
