import { describe, expect, it, vi } from 'vitest'
import { DESKTOP_GITHUB_PROJECT_LIMITS, desktopGithubRepositoryDataSchema } from '@rerun/contracts'
const page = vi.hoisted(() => ({ readPublicPage: vi.fn() }))
vi.mock('../web-fetch/transport.ts', () => page)
import { fakeGithub, file, ref } from './fixtures.test-support.ts'
import { confinedGithubReader, readGithubRepositories, readGithubRepository } from './reader.ts'

const signal = () => new AbortController().signal

describe('reading one public repository as data', () => {
    it('reads the description, language, topics, branch, top-level files, README and manifests', async () => {
        const github = fakeGithub({ 'acme/openflix': {
            meta: { description: 'Streams\nfor\u0000 everyone', language: 'Swift', topics: ['ios', 'tv'], default_branch: 'develop' },
            files: { 'Package.swift': '// swift-tools-version:5.9', '.gitmodules': '[submodule "tuner"]', LICENSE: 'MIT' },
            directories: ['OpenFlix.xcodeproj', 'Sources'], readme: '# OpenFlix\nAn Apple app.',
        } })
        const result = await readGithubRepository(ref('Acme', 'OpenFlix'), github.read, signal())
        expect(result).toMatchObject({ ok: true, data: {
            id: 'acme/openflix', description: 'Streams for everyone', language: 'Swift', topics: ['ios', 'tv'], defaultBranch: 'develop',
            files: ['Package.swift', '.gitmodules', 'LICENSE', 'OpenFlix.xcodeproj/', 'Sources/'], readme: '# OpenFlix\nAn Apple app.',
            manifests: [{ path: '.gitmodules', text: '[submodule "tuner"]' }, { path: 'Package.swift', text: '// swift-tools-version:5.9' }],
        } })
        expect(desktopGithubRepositoryDataSchema.safeParse(result.ok && result.data).success).toBe(true)
        // Only this repository's own API paths are asked for; the project file is a name, never read.
        expect(github.paths).toEqual(['/repos/Acme/OpenFlix', '/repos/Acme/OpenFlix/contents/', '/repos/Acme/OpenFlix/readme', '/repos/Acme/OpenFlix/contents/.gitmodules', '/repos/Acme/OpenFlix/contents/Package.swift'])
    })

    it('keeps the first 20 KB of the README and 8 KB of a manifest, and at most four manifests', async () => {
        const github = fakeGithub({ 'acme/big': {
            files: { 'package.json': 'p'.repeat(30_000), 'build.gradle': 'g', 'settings.gradle': 's', 'Cargo.toml': 'c', 'go.mod': 'm', Dockerfile: 'd' },
            readme: `${'é'.repeat(30_000)}`,
        } })
        const result = await readGithubRepository(ref('acme', 'big'), github.read, signal())
        if (!result.ok) throw new Error('expected a read')
        expect(Buffer.byteLength(result.data.readme!, 'utf8')).toBeLessThanOrEqual(DESKTOP_GITHUB_PROJECT_LIMITS.readmeBytes)
        expect(result.data.readme!.length).toBe(DESKTOP_GITHUB_PROJECT_LIMITS.readmeBytes / 2)
        expect(result.data.manifests.map(item => item.path)).toEqual(['package.json', 'build.gradle', 'settings.gradle', 'Cargo.toml'])
        expect(result.data.manifests[0]!.text).toHaveLength(DESKTOP_GITHUB_PROJECT_LIMITS.manifestBytes)
        expect(github.paths).toHaveLength(3 + DESKTOP_GITHUB_PROJECT_LIMITS.maxManifests)
    })

    it('keeps at most 200 top-level names and ignores entries that are not plain names', async () => {
        const read = fakeGithub({}).read
        const listing = JSON.stringify([{ name: '../etc', type: 'file' }, { name: 7, type: 'file' }, ...Array.from({ length: 400 }, (_, index) => ({ name: `f${index}.txt`, type: 'file' }))])
        const result = await readGithubRepository(ref('acme', 'many'), async path => path.endsWith('/contents/') ? { ok: true, status: 200, body: listing }
            : path.endsWith('/many') ? { ok: true, status: 200, body: '{}' } : read(path, signal()), signal())
        if (!result.ok) throw new Error('expected a read')
        expect(result.data.files).toHaveLength(DESKTOP_GITHUB_PROJECT_LIMITS.maxFiles)
        expect(result.data.files[0]).toBe('f0.txt')
    })

    it.each([
        [404, 'not_found'], [451, 'not_found'], [403, 'rate_limited'], [429, 'rate_limited'], [500, 'failed'],
    ] as const)('status %s is reported as %s without reading further', async (status, failure) => {
        const github = fakeGithub({ 'acme/secret': { status } })
        expect(await readGithubRepository(ref('acme', 'secret'), github.read, signal())).toEqual({ ref: ref('acme', 'secret'), ok: false, failure })
        expect(github.paths).toEqual(['/repos/acme/secret'])
    })

    it('a timeout, a broken answer or a repository that says it is private is a failure, not a guess', async () => {
        const one = ref('acme', 'one')
        expect(await readGithubRepository(one, async () => ({ ok: false, reason: 'timeout' }), signal())).toMatchObject({ ok: false, failure: 'timeout' })
        expect(await readGithubRepository(one, async () => ({ ok: true, status: 200, body: '<html>' }), signal())).toMatchObject({ ok: false, failure: 'failed' })
        expect(await readGithubRepository(one, async () => ({ ok: true, status: 200, body: '{"private":true}' }), signal())).toMatchObject({ ok: false, failure: 'not_found' })
    })

    it('a README or file list that cannot be read leaves the repository read, without them', async () => {
        const github = fakeGithub({ 'acme/bare': { files: { 'package.json': '{}' } } }, { fail: path => path.endsWith('/contents/') ? { ok: false, reason: 'failed' } : null })
        expect(await readGithubRepository(ref('acme', 'bare'), github.read, signal())).toMatchObject({ ok: true, data: { files: [], readme: null, manifests: [] } })
    })

    it('a file answer that is not base64 text is treated as absent', async () => {
        const base = fakeGithub({ 'acme/odd': { files: { 'package.json': '{}' }, readme: 'x' } })
        const result = await readGithubRepository(ref('acme', 'odd'), async path => path.endsWith('/readme') ? { ok: true, status: 200, body: JSON.stringify({ type: 'file', encoding: 'none', content: 'run me' }) }
            : path.endsWith('package.json') ? { ok: true, status: 200, body: '[]' } : base.read(path, signal()), signal())
        expect(result).toMatchObject({ ok: true, data: { readme: null, manifests: [] } })
    })
})

describe('reading the whole list', () => {
    const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`acme/r${index}`, {
        files: { 'package.json': '{}', 'build.gradle': 'g', 'settings.gradle': 's', 'Cargo.toml': 'c', 'go.mod': 'm' }, readme: 'r',
    }]))

    it('twelve repositories stay inside the request budget and every one is still read', async () => {
        const github = fakeGithub(many(12))
        const results = await readGithubRepositories(Array.from({ length: 12 }, (_, index) => ref('acme', `r${index}`)), github.read, signal())
        expect(results.every(result => result.ok)).toBe(true)
        expect(github.paths.length).toBeLessThanOrEqual(DESKTOP_GITHUB_PROJECT_LIMITS.requestBudget)
        expect(github.paths.length).toBe(DESKTOP_GITHUB_PROJECT_LIMITS.requestBudget)
        expect(results.map(result => result.ref.id)).toEqual(Array.from({ length: 12 }, (_, index) => `acme/r${index}`))
    })

    it('never reads more than twelve repositories', async () => {
        const github = fakeGithub(many(14))
        expect(await readGithubRepositories(Array.from({ length: 14 }, (_, index) => ref('acme', `r${index}`)), github.read, signal())).toHaveLength(12)
    })

    it('a private repository is reported and the others carry on', async () => {
        const github = fakeGithub({ 'acme/open': { readme: 'hello' } })
        const results = await readGithubRepositories([ref('acme', 'hidden'), ref('acme', 'open')], github.read, signal())
        expect(results).toMatchObject([{ ok: false, failure: 'not_found' }, { ok: true, data: { readme: 'hello' } }])
    })

    it('once GitHub starts refusing, the remaining repositories are not asked', async () => {
        const github = fakeGithub({ 'acme/a': { status: 403 }, 'acme/b': { status: 403 }, 'acme/c': { status: 403 }, 'acme/d': {}, 'acme/e': {}, 'acme/f': {} })
        const results = await readGithubRepositories(['a', 'b', 'c', 'd', 'e', 'f'].map(name => ref('acme', name)), github.read, signal())
        expect(results.every(result => !result.ok && result.failure === 'rate_limited')).toBe(true)
        expect(github.paths).toEqual(['/repos/acme/a', '/repos/acme/b', '/repos/acme/c'])
    })

    it('stops at the run deadline and reports what was not reached', async () => {
        const slow = async (_path: string, aborted: AbortSignal) => new Promise<{ ok: false; reason: 'timeout' }>(resolve => aborted.addEventListener('abort', () => resolve({ ok: false, reason: 'timeout' }), { once: true }))
        const results = await readGithubRepositories(['a', 'b', 'c', 'd'].map(name => ref('acme', name)), slow, signal(), { runDeadlineMs: 30 })
        expect(results.map(result => !result.ok && result.failure)).toEqual(['timeout', 'timeout', 'timeout', 'timeout'])
    })
})

describe('the production reader', () => {
    it('asks only api.github.com, through the guarded public fetch, with the host pinned on every hop', async () => {
        page.readPublicPage.mockResolvedValueOnce({ url: 'https://api.github.com/repos/acme/a', status: 200, contentType: 'application/json', xRobotsTag: null, body: '{}', bytes: 2 })
        const permission = vi.fn(async () => {})
        expect(await confinedGithubReader(permission)('/repos/acme/a', signal())).toEqual({ ok: true, status: 200, body: '{}' })
        const [url, , assert, options] = page.readPublicPage.mock.calls[0]!
        expect(url).toBe('https://api.github.com/repos/acme/a')
        expect(assert).toBe(permission)
        expect(options.allowHost('api.github.com')).toBe(true)
        for (const host of ['github.com', 'raw.githubusercontent.com', 'api.github.com.evil.example', 'evil.example']) expect(options.allowHost(host)).toBe(false)
    })

    it('refuses any path outside /repos/ and turns a failed read into a plain failure', async () => {
        page.readPublicPage.mockClear()
        expect(await confinedGithubReader(async () => {})('/user', signal())).toEqual({ ok: false, reason: 'failed' })
        expect(page.readPublicPage).not.toHaveBeenCalled()
        page.readPublicPage.mockRejectedValueOnce(new Error('Not a public host this read is allowed to reach'))
        expect(await confinedGithubReader(async () => {})('/repos/acme/a', signal())).toEqual({ ok: false, reason: 'failed' })
        const stopped = new AbortController(); stopped.abort()
        page.readPublicPage.mockRejectedValueOnce(new Error('Cancelled'))
        expect(await confinedGithubReader(async () => {})('/repos/acme/a', stopped.signal)).toEqual({ ok: false, reason: 'cancelled' })
    })
})

it('the fixture encodes files the way the contents API does', () => {
    expect(JSON.parse(file('hello')).encoding).toBe('base64')
})
