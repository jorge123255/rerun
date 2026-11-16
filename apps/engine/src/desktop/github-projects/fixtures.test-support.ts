import type { DesktopGithubRepositoryData, DesktopGithubRepositoryRef } from '@rerun/contracts'
import type { GithubApiRead, GithubApiReader } from './reader.ts'

// Synthetic repositories for tests: nothing here is a real project and nothing opens a socket.

export const ref = (owner: string, name: string): DesktopGithubRepositoryRef => ({ id: `${owner}/${name}`.toLowerCase(), owner, name, url: `https://github.com/${owner}/${name}` })

export const data = (id: string, patch: Partial<DesktopGithubRepositoryData> = {}): DesktopGithubRepositoryData => ({
    id, description: null, language: null, topics: [], defaultBranch: 'main', files: [], readme: null, manifests: [], ...patch,
})

export const file = (text: string) => JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n') })

export type FakeRepository = {
    meta?: Record<string, unknown>
    status?: number
    files?: Record<string, string>
    directories?: string[]
    readme?: string | null
}

/** A reader over synthetic repositories that records every path it is asked for. */
export function fakeGithub(repositories: Record<string, FakeRepository>, options?: { fail?: (path: string) => GithubApiRead | null }) {
    const paths: string[] = []
    const read: GithubApiReader = async path => {
        paths.push(path)
        const forced = options?.fail?.(path)
        if (forced) return forced
        const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path)
        const repository = match ? repositories[`${match[1]}/${match[2]}`.toLowerCase()] : undefined
        if (!match || !repository) return { ok: true, status: 404, body: '{"message":"Not Found"}' }
        if (repository.status && repository.status !== 200) return { ok: true, status: repository.status, body: '{"message":"refused"}' }
        const rest = match[3] ?? ''
        if (!rest) return { ok: true, status: 200, body: JSON.stringify({ description: null, language: null, topics: [], default_branch: 'main', private: false, ...repository.meta }) }
        if (rest === '/contents/') {
            return { ok: true, status: 200, body: JSON.stringify([
                ...Object.keys(repository.files ?? {}).map(name => ({ name, type: 'file' })),
                ...(repository.directories ?? []).map(name => ({ name, type: 'dir' })),
            ]) }
        }
        if (rest === '/readme') return repository.readme == null ? { ok: true, status: 404, body: '{}' } : { ok: true, status: 200, body: file(repository.readme) }
        const name = decodeURIComponent(rest.replace('/contents/', ''))
        const text = repository.files?.[name]
        return text === undefined ? { ok: true, status: 404, body: '{}' } : { ok: true, status: 200, body: file(text) }
    }
    return { read, paths }
}
