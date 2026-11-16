// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopGithubProject } from '@rerun/contracts'
import type { DesktopIntakeGithubController } from '@/lib/desktop/foreman-intake/use-desktop-intake-github'
import { resetDesktopArrivalsForTest } from '../panel-motion/DesktopArrive'
import { giveGithubToTeam, type DesktopGithubTeamAccess, type GithubTeamAccessPorts } from '@/lib/desktop/github-team-access'
import { DESKTOP_GITHUB_UPDATE_PROPOSAL, DesktopForemanGithubProjects } from './DesktopForemanGithubProjects'

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
const chat = { workspaceId: '1', chatId: 'fmc_githubbar0001' }
const noTeam: DesktopGithubTeamAccess = { team: [], via: null, entry: null, account: null, alsoGives: [] }
function accessPorts(first: DesktopGithubTeamAccess = noTeam) {
    const state = { access: first, shared: [] as string[][], allowed: [] as string[] }
    const ports: GithubTeamAccessPorts = {
        read: async () => state.access,
        shareEntry: async (_entry, agentIds) => { state.shared.push(agentIds); state.access = { ...state.access, team: state.access.team.map(member => ({ ...member, assigned: member.assigned || agentIds.includes(member.id) })) } },
        attachAccount: async () => {},
        allowApps: async id => { state.allowed.push(id); state.access = { ...state.access, team: state.access.team.map(member => member.id === id ? { ...member, allowed: true } : member) } },
    }
    return { ports, state }
}
async function render(controller: DesktopIntakeGithubController, extra: Partial<Parameters<typeof DesktopForemanGithubProjects>[0]> = {}) {
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopForemanGithubProjects github={controller} chat={chat} accessPorts={accessPorts().ports} {...extra} />))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
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

it('offers to pass an edit on to the Chief of Staff, and sends the request in the person\'s name', async () => {
    const send = vi.fn()
    const controller = github([project('openflix')])
    await render(controller, { onSend: send })
    expect(document.querySelector('[data-foreman-github-update]')).toBeNull()
    await act(async () => toggle()!.click())
    await act(async () => document.querySelector<HTMLInputElement>('[data-intake-github-role="qa-tester"]')!.click())
    expect(controller.edit).toHaveBeenCalledWith({ type: 'set-role', id: 'acme/openflix', role: 'qa-tester', on: true })
    const update = [...document.querySelectorAll<HTMLButtonElement>('[data-foreman-github-update] button')].find(button => button.textContent === 'Update the proposal')!
    await act(async () => update.click())
    expect(send).toHaveBeenCalledWith(DESKTOP_GITHUB_UPDATE_PROPOSAL)
    expect(document.querySelector('[data-foreman-github-update]')).toBeNull()
})

const member = (id: string, patch = {}) => ({ id, name: `Dev ${id}`, repository: 'acme/openflix', assigned: false, allowed: false, ...patch })
const connect = (team: DesktopGithubTeamAccess['team']): DesktopGithubTeamAccess => ({ team, via: 'composio-connect', entry: { id: 'e1', revision: 'r1', sharedWithAll: false, agentIds: ['other'] }, account: null, alsoGives: ['Gmail', 'YouTube'] })

it('gives GitHub to the whole team only after saying what that gives', async () => {
    const { ports, state } = accessPorts(connect([member('a'), member('b', { assigned: true, allowed: true })]))
    await render(github([project('openflix')]), { accessPorts: ports })
    const area = () => document.querySelector('[data-foreman-github-access]')!
    expect(area().textContent).toContain('1 of 2 coworkers can use GitHub')
    await act(async () => document.querySelector<HTMLButtonElement>('[data-foreman-github-give]')!.click())
    // Nothing is assigned by asking: the caveat is shown first.
    expect(state.shared).toEqual([])
    expect(area().textContent).toContain('assigns your Composio sign-in to 1 coworker and turns on Custom MCP servers')
    expect(area().textContent).toContain('they will also reach Gmail, YouTube')
    expect(area().textContent).toContain('still ask you first')
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-foreman-github-give-confirm]')!.click(); await new Promise(resolve => setTimeout(resolve, 5)) })
    // The entry keeps who had it and gains the coworker that lacked it.
    expect(state.shared).toEqual([['other', 'a']])
    expect(state.allowed).toEqual(['a'])
    expect(area().textContent).toContain('All 2 coworkers of these projects can use GitHub')
})

it('says to sign in first when GitHub is not signed in, and reports a coworker that could not be given it', async () => {
    const { ports } = accessPorts({ ...noTeam, team: [member('a')] })
    await render(github([project('openflix')]), { accessPorts: ports })
    expect(document.querySelector('[data-foreman-github-access]')!.textContent).toContain('Sign in to GitHub in the Vault')
    expect(document.querySelector('[data-foreman-github-give]')).toBeNull()

    const failing = accessPorts(connect([member('a'), member('b')]))
    failing.ports.allowApps = async id => { if (id === 'b') throw new Error('This tool is unavailable for this coworker.'); failing.state.access = { ...failing.state.access, team: failing.state.access.team.map(row => row.id === id ? { ...row, allowed: true } : row) } }
    const result = await giveGithubToTeam(failing.ports)
    expect(result.failed).toBe(1)
    expect(result.message).toBe('This tool is unavailable for this coworker.')
    // A project key attaches the GitHub account alone, one coworker at a time.
    const attached: string[] = []
    const keyed = accessPorts({ team: [member('a', { allowed: true }), member('b', { assigned: true, allowed: true })], via: 'composio-project', entry: null, account: { id: 'gh1' }, alsoGives: [] })
    keyed.ports.attachAccount = async (account, agent) => { attached.push(`${account}:${agent}`) }
    await giveGithubToTeam(keyed.ports)
    expect(attached).toEqual(['gh1:a'])
})
