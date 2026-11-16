import { expect, test, vi } from 'vitest'
import { readGithubRepository, type GithubApiRead, type GithubApiReader } from '../../../../../engine/src/desktop/github-projects/index.ts'
import { githubReaderWithSignIn, type GithubSignInRead } from './sign-in-reader'

const never = new AbortController().signal
const ok = (status: number, value: unknown = {}): GithubApiRead => ({ ok: true, status, body: JSON.stringify(value) })
const base64 = (text: string) => ({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') })

/** GitHub as the owner's sign-in sees it: one private repository. */
function signedIn(seen: string[]): GithubSignInRead {
    return async path => {
        seen.push(path)
        if (path === '/repos/acme/secret') return { status: 200, data: { private: true, description: 'Private app', language: 'Swift', default_branch: 'main', topics: [] } }
        if (path === '/repos/acme/secret/contents/') return { status: 200, data: [{ name: 'Package.swift', type: 'file' }, { name: 'Sources', type: 'dir' }] }
        if (path === '/repos/acme/secret/readme') return { status: 200, data: base64('# Secret app') }
        if (path === '/repos/acme/secret/contents/Package.swift') return { status: 200, data: base64('// swift-tools-version:6.0') }
        return { status: 404, data: { message: 'Not Found' } }
    }
}

test('a public repository is read the plain way and the sign-in is never opened', async () => {
    const open = vi.fn(async () => signedIn([]))
    const direct: GithubApiReader = async path => path === '/repos/acme/open/readme' ? ok(404) : ok(200, path.endsWith('/contents/') ? [] : { private: false })
    const read = githubReaderWithSignIn(direct, open, async () => {})
    const result = await readGithubRepository({ id: 'acme/open', owner: 'acme', name: 'open' } as never, read, never)
    expect(result.ok).toBe(true)
    expect(open).not.toHaveBeenCalled()
})

test('a repository the plain read cannot see is read whole through the sign-in', async () => {
    const seen: string[] = [], plain: string[] = []
    const direct: GithubApiReader = async path => { plain.push(path); return ok(404) }
    const read = githubReaderWithSignIn(direct, async () => signedIn(seen), async () => {})
    const result = await readGithubRepository({ id: 'acme/secret', owner: 'acme', name: 'secret' } as never, read, never)
    expect(result).toMatchObject({ ok: true, data: { description: 'Private app', files: ['Package.swift', 'Sources/'], readme: '# Secret app', manifests: [{ path: 'Package.swift' }] } })
    // GitHub was asked the plain way once; everything after went through the sign-in.
    expect(plain).toEqual(['/repos/acme/secret'])
    expect(seen).toEqual(['/repos/acme/secret', '/repos/acme/secret/contents/', '/repos/acme/secret/readme', '/repos/acme/secret/contents/Package.swift'])
})

test('with no GitHub account signed in, or one that cannot see it, the repository stays not found', async () => {
    const direct: GithubApiReader = async () => ok(404)
    const ref = { id: 'acme/other', owner: 'acme', name: 'other' } as never
    expect(await readGithubRepository(ref, githubReaderWithSignIn(direct, async () => null, async () => {}), never)).toMatchObject({ ok: false, failure: 'not_found' })
    expect(await readGithubRepository(ref, githubReaderWithSignIn(direct, async () => signedIn([]), async () => {}), never)).toMatchObject({ ok: false, failure: 'not_found' })
    // A sign-in that fails to open is the same as none.
    expect(await readGithubRepository(ref, githubReaderWithSignIn(direct, async () => { throw new Error('offline') }, async () => {}), never)).toMatchObject({ ok: false, failure: 'not_found' })
})

test('a rate-limited plain read is answered by the sign-in', async () => {
    const direct: GithubApiReader = async () => ok(403)
    const read = githubReaderWithSignIn(direct, async () => signedIn([]), async () => {})
    expect((await readGithubRepository({ id: 'acme/secret', owner: 'acme', name: 'secret' } as never, read, never)).ok).toBe(true)
})

test('nothing is read through the sign-in when the conversation is not permitted', async () => {
    const seen: string[] = []
    const read = githubReaderWithSignIn(async () => ok(404), async () => signedIn(seen), async () => { throw new Error('not yours') })
    expect(await read('/repos/acme/secret', never)).toEqual(ok(404))
    expect(seen).toEqual([])
})

test('only repository paths are read', async () => {
    const direct = vi.fn(async () => ok(200))
    const read = githubReaderWithSignIn(direct, async () => signedIn([]), async () => {})
    expect(await read('/user', never)).toEqual({ ok: false, reason: 'failed' })
    expect(await read('/repos/acme', never)).toEqual({ ok: false, reason: 'failed' })
    expect(direct).not.toHaveBeenCalled()
})
