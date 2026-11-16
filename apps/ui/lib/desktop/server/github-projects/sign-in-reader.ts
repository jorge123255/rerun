import type { GithubApiRead, GithubApiReader } from '../../../../../engine/src/desktop/github-projects/index.ts'

/** GitHub's answer to one GET under /repos/, fetched with the owner's GitHub sign-in. */
export type GithubSignInRead = (path: string, signal: AbortSignal) => Promise<{ status: number; data: unknown }>

// Composio signs and forwards each read, which takes longer than asking GitHub directly.
const SIGN_IN_DEADLINE_MS = 15_000
const MAX_BODY = 2_000_000

/**
 * Reads repositories the plain way first, and through the owner's GitHub sign-in (the one the Vault
 * holds at Composio) only for a repository the plain read could not see or was refused for. A public
 * repository is therefore never sent to Composio. Once a repository has answered through the
 * sign-in, its other files are read the same way.
 *
 * `signIn` is asked for once, at the first repository that needs it; null means no GitHub account is
 * signed in. `permitted` runs before every read through the sign-in, as it does before a plain one.
 */
export function githubReaderWithSignIn(direct: GithubApiReader, signIn: () => Promise<GithubSignInRead | null>, permitted: () => Promise<void>): GithubApiReader {
    const through = new Set<string>()
    let opened: Promise<GithubSignInRead | null> | null = null
    const viaSignIn = async (path: string, parent: AbortSignal): Promise<GithubApiRead | null> => {
        const timeout = AbortSignal.timeout(SIGN_IN_DEADLINE_MS)
        try {
            await permitted()
            const read = await (opened ??= signIn().catch(() => null))
            if (!read) return null
            const answer = await read(path, AbortSignal.any([parent, timeout]))
            const body = JSON.stringify(answer.data ?? null)
            if (body.length > MAX_BODY) return { ok: false, reason: 'failed' }
            return { ok: true, status: answer.status, body, withToken: true }
        } catch {
            if (parent.aborted) return { ok: false, reason: 'cancelled' }
            return { ok: false, reason: timeout.aborted ? 'timeout' : 'failed' }
        }
    }
    return async (path, signal) => {
        const parts = path.split('/')
        if (parts[1] !== 'repos' || !parts[2] || !parts[3]) return { ok: false, reason: 'failed' }
        const repository = `${parts[2]}/${parts[3]}`.toLowerCase()
        if (through.has(repository)) return await viaSignIn(path, signal) ?? { ok: false, reason: 'failed' }
        const plain = await direct(path, signal)
        // Only the repository's own page decides: a public repository without a README stays a plain read.
        if (parts.length > 4 || !plain.ok || (plain.status !== 404 && plain.status !== 403 && plain.status !== 429)) return plain
        const signed = await viaSignIn(path, signal)
        if (signed?.ok && signed.status === 200) { through.add(repository); return signed }
        // A sign-in that cannot see it either leaves GitHub's first answer standing, unless that was only a rate limit.
        return signed?.ok && signed.status === 404 && plain.status !== 404 ? signed : plain
    }
}
