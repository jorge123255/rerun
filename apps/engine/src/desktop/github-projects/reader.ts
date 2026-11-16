import {
    DESKTOP_GITHUB_PROJECT_LIMITS,
    type DesktopGithubReadFailure,
    type DesktopGithubRepositoryData,
    type DesktopGithubRepositoryRef,
} from '@rerun/contracts'
import { readPublicPage } from '../web-fetch/transport.ts'

// Reads repositories from api.github.com as data. Without a token only public repositories answer.
// With the owner's read-only token (Settings, Tool services) the ones that token can see answer too.
// The token is sent to api.github.com and nowhere else. Nothing is cloned, installed or run.

export const GITHUB_API_HOST = 'api.github.com'

export type GithubApiRead = { ok: true; status: number; body: string; /** The owner's token was sent with this read. */ withToken?: boolean } | { ok: false; reason: 'timeout' | 'failed' | 'cancelled' }
/** `path` always starts with `/repos/`. Tests supply this port and never open a socket. */
export type GithubApiReader = (path: string, signal: AbortSignal) => Promise<GithubApiRead>

/** The production reader: the app's guarded public fetch, pinned to api.github.com on every hop. */
export function confinedGithubReader(assertPermission: () => Promise<void>, token?: () => Promise<string | null>): GithubApiReader {
    return async (path, parent) => {
        if (!path.startsWith('/repos/')) return { ok: false, reason: 'failed' }
        const timeout = AbortSignal.timeout(DESKTOP_GITHUB_PROJECT_LIMITS.requestDeadlineMs)
        const signal = AbortSignal.any([parent, timeout])
        try {
            // Read fresh each time, so a token removed in Settings stops being sent at once.
            const secret = token ? await token().catch(() => null) : null
            const usable = secret && /^[\x21-\x7e]{20,400}$/.test(secret) ? secret : null
            const page = await readPublicPage(`https://${GITHUB_API_HOST}${path}`, signal, assertPermission, {
                allowHost: host => host === GITHUB_API_HOST,
                ...(usable && { headers: { Authorization: `Bearer ${usable}`, 'X-GitHub-Api-Version': '2022-11-28' } }),
            })
            return { ok: true, status: page.status, body: page.body, ...(usable && { withToken: true }) }
        } catch {
            if (parent.aborted) return { ok: false, reason: 'cancelled' }
            return { ok: false, reason: timeout.aborted ? 'timeout' : 'failed' }
        }
    }
}

/** The manifest files worth reading, most telling first. Only top-level files are ever read. */
export const GITHUB_MANIFEST_FILES = [
    '.gitmodules', 'package.json', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'Package.swift', 'Podfile',
    'pubspec.yaml', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Dockerfile', 'docker-compose.yml',
] as const

export type GithubRequestBudget = { left: number }
export type GithubRepositoryRead =
    | { ref: DesktopGithubRepositoryRef; ok: true; data: DesktopGithubRepositoryData }
    | { ref: DesktopGithubRepositoryRef; ok: false; failure: DesktopGithubReadFailure }

function cutBytes(text: string, max: number): string {
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.byteLength <= max) return text
    // A cut in the middle of a character leaves a replacement mark at the end: drop it.
    return bytes.subarray(0, max).toString('utf8').replace(/\uFFFD+$/, '')
}

const plain = (value: unknown, max: number): string | null => {
    if (typeof value !== 'string') return null
    const cleaned = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim()
    return cleaned ? cleaned.slice(0, max) : null
}

function json(body: string): unknown {
    try { return JSON.parse(body) } catch { return null }
}

/** A file from the contents API: base64 text, cut to size. Anything else is treated as absent. */
function fileText(body: string, max: number): string | null {
    const value = json(body) as { type?: unknown; encoding?: unknown; content?: unknown } | null
    if (!value || Array.isArray(value) || value.type !== 'file' || value.encoding !== 'base64' || typeof value.content !== 'string') return null
    try {
        // Only as much base64 as the kept bytes need is decoded.
        const encoded = value.content.replace(/\s+/g, '').slice(0, Math.ceil(max / 3) * 4 + 4)
        return cutBytes(Buffer.from(encoded, 'base64').toString('utf8').replace(/\u0000/g, ''), max)
    } catch { return null }
}

function failureOf(read: GithubApiRead): DesktopGithubReadFailure | null {
    if (!read.ok) return read.reason === 'timeout' ? 'timeout' : 'failed'
    if (read.status === 401) return 'token_refused'
    if (read.status === 404 || read.status === 451) return 'not_found'
    if (read.status === 403 || read.status === 429) return 'rate_limited'
    return read.status === 200 ? null : 'failed'
}

export async function readGithubRepository(
    ref: DesktopGithubRepositoryRef,
    read: GithubApiReader,
    parent: AbortSignal,
    budget: GithubRequestBudget = { left: 3 + DESKTOP_GITHUB_PROJECT_LIMITS.maxManifests },
): Promise<GithubRepositoryRead> {
    const timeout = AbortSignal.timeout(DESKTOP_GITHUB_PROJECT_LIMITS.repositoryDeadlineMs)
    const signal = AbortSignal.any([parent, timeout])
    const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`
    const request = async (suffix: string): Promise<GithubApiRead> => {
        if (signal.aborted) return { ok: false, reason: parent.aborted ? 'cancelled' : 'timeout' }
        if (budget.left <= 0) return { ok: false, reason: 'failed' }
        budget.left -= 1
        return read(`${base}${suffix}`, signal)
    }

    const meta = await request('')
    const failed = failureOf(meta)
    if (failed || !meta.ok) return { ref, ok: false, failure: failed ?? 'failed' }
    const repository = json(meta.body) as Record<string, unknown> | null
    if (!repository || Array.isArray(repository) || typeof repository !== 'object') return { ref, ok: false, failure: 'failed' }
    // Without the owner's token this cannot be a private repository; if it ever says so it is not read.
    if (repository.private === true && !meta.withToken) return { ref, ok: false, failure: 'not_found' }

    const listing = await request('/contents/')
    const entries = listing.ok && listing.status === 200 ? json(listing.body) : null
    const top: { name: string; file: boolean }[] = []
    if (Array.isArray(entries)) {
        for (const entry of entries as { name?: unknown; type?: unknown }[]) {
            const name = plain(entry?.name, 150)
            if (!name || name.includes('/')) continue
            top.push({ name, file: entry.type === 'file' })
            if (top.length >= DESKTOP_GITHUB_PROJECT_LIMITS.maxFiles) break
        }
    }

    const readmeRead = await request('/readme')
    const readme = readmeRead.ok && readmeRead.status === 200 ? fileText(readmeRead.body, DESKTOP_GITHUB_PROJECT_LIMITS.readmeBytes) : null

    const manifests: DesktopGithubRepositoryData['manifests'] = []
    const present = new Set(top.filter(entry => entry.file).map(entry => entry.name))
    for (const path of GITHUB_MANIFEST_FILES) {
        if (manifests.length >= DESKTOP_GITHUB_PROJECT_LIMITS.maxManifests || budget.left <= 0 || signal.aborted) break
        if (!present.has(path)) continue
        const file = await request(`/contents/${encodeURIComponent(path)}`)
        const text = file.ok && file.status === 200 ? fileText(file.body, DESKTOP_GITHUB_PROJECT_LIMITS.manifestBytes) : null
        if (text) manifests.push({ path, text })
    }

    const topics = Array.isArray(repository.topics)
        ? repository.topics.flatMap(topic => plain(topic, 60) ?? []).slice(0, DESKTOP_GITHUB_PROJECT_LIMITS.maxTopics) : []
    return {
        ref, ok: true,
        data: {
            id: ref.id,
            description: plain(repository.description, 400),
            language: plain(repository.language, 60),
            topics,
            defaultBranch: plain(repository.default_branch, 120),
            files: top.map(entry => entry.file ? entry.name : `${entry.name}/`),
            readme: readme || null,
            manifests,
        },
    }
}

/**
 * Reads every listed repository, a few at a time, inside one deadline and one request budget.
 * Three requests are kept back for each repository so the last one is not starved by the first
 * one's manifest files. Once GitHub starts refusing, the rest are not asked.
 */
export async function readGithubRepositories(
    refs: readonly DesktopGithubRepositoryRef[],
    read: GithubApiReader,
    parent: AbortSignal,
    options?: { requestBudget?: number; runDeadlineMs?: number },
): Promise<GithubRepositoryRead[]> {
    const list = refs.slice(0, DESKTOP_GITHUB_PROJECT_LIMITS.maxRepositories)
    const timeout = AbortSignal.timeout(options?.runDeadlineMs ?? DESKTOP_GITHUB_PROJECT_LIMITS.runDeadlineMs)
    const signal = AbortSignal.any([parent, timeout])
    const total = options?.requestBudget ?? DESKTOP_GITHUB_PROJECT_LIMITS.requestBudget
    const shared = { extra: Math.max(0, total - 3 * list.length) }
    const results = new Array<GithubRepositoryRead>(list.length)
    let limited = false
    let next = 0
    const worker = async () => {
        while (next < list.length) {
            const index = next++
            const ref = list[index]!
            if (limited) { results[index] = { ref, ok: false, failure: 'rate_limited' }; continue }
            if (signal.aborted) { results[index] = { ref, ok: false, failure: 'timeout' }; continue }
            const extra = Math.min(shared.extra, DESKTOP_GITHUB_PROJECT_LIMITS.maxManifests)
            shared.extra -= extra
            const budget = { left: 3 + extra }
            const result = await readGithubRepository(ref, read, signal, budget).catch((): GithubRepositoryRead => ({ ref, ok: false, failure: 'failed' }))
            // Manifest requests that were not needed go back to the pool for the repositories still to read.
            shared.extra += Math.min(extra, Math.max(0, budget.left))
            if (!result.ok && result.failure === 'rate_limited') limited = true
            results[index] = result
        }
    }
    await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker))
    return results
}
