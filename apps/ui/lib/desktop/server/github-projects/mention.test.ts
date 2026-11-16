import { expect, test, vi } from 'vitest'
import { githubRepositoryLinksInText, type DesktopGithubProjectsRecord } from '@rerun/contracts'

vi.mock('server-only', () => ({}))
const { createDesktopGithubProjectsService } = await import('./service')
const { desktopGithubProjectsPendingInstruction } = await import('../../foreman-intake/github-projects')
import type { GithubApiReader } from '../../../../../engine/src/desktop/github-projects/index.ts'

const chat = { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000001' }

test('repositories are found in a sentence, in order, once each, and only as full github.com links', () => {
    const text = 'Build a team for https://github.com/acme/openflix, and (https://github.com/acme/dvr-tuner/tree/main). See acme/other and https://github.com/Acme/OpenFlix again. Docs: https://github.com/features/actions https://gitlab.com/acme/x'
    expect(githubRepositoryLinksInText(text).map(repository => repository.id)).toEqual(['acme/openflix', 'acme/dvr-tuner'])
    expect(githubRepositoryLinksInText('no links here')).toEqual([])
    expect(githubRepositoryLinksInText(Array.from({ length: 20 }, (_, index) => `https://github.com/acme/r${index}`).join(' '))).toHaveLength(12)
})

function fixture(delayMs = 0) {
    let current: DesktopGithubProjectsRecord | null = null
    const saved = new Map<string, DesktopGithubProjectsRecord>()
    const asked: string[] = []
    const read: GithubApiReader = async path => {
        asked.push(path)
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
        if (path.includes('/missing')) return { ok: true, status: 404, body: '{}' }
        if (path.endsWith('/contents/')) return { ok: true, status: 200, body: JSON.stringify([{ name: 'Package.swift', type: 'file' }]) }
        if (path.endsWith('/readme') || path.includes('/contents/')) return { ok: true, status: 404, body: '{}' }
        return { ok: true, status: 200, body: JSON.stringify({ description: 'An app', language: 'Swift', default_branch: 'main', topics: [] }) }
    }
    const understand = vi.fn()
    const model = vi.fn()
    const service = createDesktopGithubProjectsService({
        store: {
            current: async () => current,
            byKey: async (_chat, key) => saved.get(key) ?? null,
            save: async (_chat, record) => { saved.set(record.key, record); current = record },
            clear: async () => { current = null },
        },
        read, model, understand, now: () => '2026-11-16T12:00:00.000Z',
    }, `test-${Math.random()}`)
    return { service, asked, understand, model, current: () => current }
}

test('linked repositories are read from their files alone and saved for the conversation', async () => {
    const { service, understand, model, current } = fixture()
    const answer = await service.mention(chat, githubRepositoryLinksInText('https://github.com/acme/openflix and https://github.com/acme/missing'), 5_000)
    expect(answer.pending).toBe(false)
    expect(answer.record?.projects.map(project => [project.id, project.state])).toEqual([['acme/openflix', 'read'], ['acme/missing', 'unavailable']])
    expect(answer.record?.inference).toBe('none')
    expect(answer.record?.inferenceNote).toContain('only what the files show')
    expect(current()).toEqual(answer.record)
    // The read itself waits on no model: with none available the files-only record stands.
    expect(understand).not.toHaveBeenCalled()
})

test('a later link joins the set, what was settled is kept, and a known link reads nothing', async () => {
    const { service, asked } = fixture()
    const first = (await service.mention(chat, githubRepositoryLinksInText('https://github.com/acme/openflix'), 5_000)).record!
    const edited = await service.edit(chat, first.key, { type: 'set-role', id: 'acme/openflix', role: 'docs-writer', on: true })
    expect(edited.projects[0]!.roles).toContain('docs-writer')

    const before = asked.length
    expect((await service.mention(chat, githubRepositoryLinksInText('again https://github.com/acme/openflix'), 5_000)).record).toEqual(edited)
    expect(asked.length).toBe(before)

    const grown = (await service.mention(chat, githubRepositoryLinksInText('and https://github.com/acme/tuner'), 5_000)).record!
    expect(grown.projects.map(project => project.id)).toEqual(['acme/openflix', 'acme/tuner'])
    expect(grown.projects[0]!.roles).toContain('docs-writer')
})

test('a read that takes longer than the wait is reported as pending and still saved', async () => {
    const { service, current } = fixture(60)
    const answer = await service.mention(chat, githubRepositoryLinksInText('https://github.com/acme/openflix'), 10)
    expect(answer).toEqual({ record: null, pending: true })
    await vi.waitFor(() => expect(current()?.projects[0]?.state).toBe('read'), { timeout: 5_000 })
})

test('the pending note names the repositories as data and tells the model not to guess', () => {
    const note = desktopGithubProjectsPendingInstruction([{ owner: 'acme', name: 'openflix' }])!
    expect(note).toContain('["acme/openflix"]')
    expect(note).toContain('Do not guess')
    expect(desktopGithubProjectsPendingInstruction([])).toBeNull()
})

test('the model describes the projects after the fast read, without undoing what the owner changed', async () => {
    const { describeGithubProjects } = await import('./service')
    const project = (name: string, patch: Record<string, unknown> = {}) => ({
        id: `acme/${name}`, owner: 'acme', name, url: `https://github.com/acme/${name}`, state: 'read', failure: null, kind: 'other', kindSource: 'default',
        purpose: null, stack: ['Go'], build: null, suggestedRoles: ['developer', 'code-reviewer'], roles: ['developer', 'code-reviewer'], removed: false, ...patch,
    })
    const record = {
        key: 'k'.repeat(64), revision: 3, inference: 'none', inferenceNote: 'files only', readAt: 'x', updatedAt: 'x',
        projects: [project('server'), project('app', { roles: ['developer'] }), project('ios', { kind: 'ios-app', kindSource: 'manifest', purpose: 'Kept' })],
        links: [{ from: 'acme/app', to: 'acme/server', kind: 'depends-on', source: 'owner', quote: null }],
    } as unknown as DesktopGithubProjectsRecord
    const said = (id: string, kind: string, roles: string[]) => ({ id, kind, purpose: `About ${id}`, stack: ['Docker', 'go'], build: 'make', roles })
    const next = describeGithubProjects(record, { status: 'succeeded', projects: [said('acme/server', 'backend-service', ['developer', 'qa-tester']), said('acme/app', 'android-app', ['developer', 'qa-tester']), said('acme/ios', 'web-app', ['developer', 'docs-writer'])],
        links: [{ from: 'acme/server', to: 'acme/app', kind: 'companion', quote: 'q' }, { from: 'acme/ios', to: 'acme/server', kind: 'depends-on', quote: 'uses the API' }] } as never)
    const [server, app, ios] = next.projects
    expect([server!.kind, server!.kindSource, server!.purpose, server!.build, server!.stack, server!.roles]).toEqual(['backend-service', 'model', 'About acme/server', 'make', ['Go', 'Docker'], ['developer', 'qa-tester']])
    // Roles the owner changed stand; only the suggestion moves.
    expect([app!.kind, app!.roles, app!.suggestedRoles]).toEqual(['android-app', ['developer'], ['developer', 'qa-tester']])
    // What the files decided and what was already written stand.
    expect([ios!.kind, ios!.kindSource, ios!.purpose]).toEqual(['ios-app', 'manifest', 'Kept'])
    // The owner's link is kept, the pair is not linked twice, and a new pair is added.
    expect(next.links.map(link => [link.from, link.to, link.source])).toEqual([['acme/app', 'acme/server', 'owner'], ['acme/ios', 'acme/server', 'model']])
    expect([next.inference, next.inferenceNote]).toEqual(['model', null])
})

test('a message is answered with the model description when it arrives inside the wait', async () => {
    const { service, understand, model, current } = fixture()
    model.mockResolvedValue({ connectionId: 'c', model: 'm' })
    understand.mockResolvedValue({ status: 'succeeded', projects: [{ id: 'acme/openflix', kind: 'backend-service', purpose: 'A media server', stack: [], build: null, roles: ['developer', 'qa-tester'] }], links: [] })
    const answer = await service.mention(chat, githubRepositoryLinksInText('https://github.com/acme/openflix'), 5_000)
    // The repository's own description stands; the model's roles replace the untouched suggestion.
    expect(answer.record?.projects[0]).toMatchObject({ purpose: 'An app', roles: ['developer', 'qa-tester'] })
    expect(answer.record?.inference).toBe('model')
    expect(current()?.revision).toBe(1)
})
