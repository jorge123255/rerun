import { basename, dirname, join, resolve } from 'node:path'
import { readdir } from 'node:fs/promises'
import { z } from 'zod'

type Reader = (workspace: string, signal: AbortSignal) => Promise<Map<string, string>>
const readerKey = Symbol.for('rerun.desktop.service-skills.reader.v1')
const globals = globalThis as unknown as Record<symbol, Reader | undefined>
const unavailable = () => new Error('Could not verify app skill ownership. Try again.')
export const desktopSkillAuthorityRequired = () => process.env.RERUN_DESKTOP_APP === '1'
export const reservedServiceSkill = (slug: string) => slug.startsWith('svc-')

/** UI binds the same canonical database reader; engine uses the authenticated local callback. */
export function bindDesktopSkillOwnerReader(reader: Reader): void { globals[readerKey] = reader }

const projection = z.object({ engineAgentId: z.string(), owners: z.array(z.object({
    slug: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), name: z.string().max(256),
}).strict()).max(2048) }).strict()

export async function trustedSkillOwners(workspace: string, stop?: AbortSignal): Promise<Map<string, string>> {
    const signal = AbortSignal.any([...(stop ? [stop] : []), AbortSignal.timeout(10_000)])
    signal.throwIfAborted()
    let owners: Map<string, string>
    if (globals[readerKey]) owners = await globals[readerKey]!(workspace, signal)
    else {
        const engineAgentId = basename(dirname(workspace)), root = process.env.RERUN_DATA_DIR
        if (!root || !/^[A-Za-z0-9_-]{1,128}$/.test(engineAgentId) || resolve(/* turbopackIgnore: true */ workspace) !== join(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ root), 'agents', engineAgentId, 'workspace')) throw unavailable()
        const origin = new URL(process.env.RERUN_HUB_BASE_URL ?? '')
        const token = process.env.RERUN_API_KEY
        if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash || !token) throw unavailable()
        const response = await fetch(`${origin.origin}/api/desktop/internal/service-skills`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ engineAgentId }), signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
        })
        const reader = response.body?.getReader()
        if (!reader) throw unavailable()
        const chunks: Uint8Array[] = []; let size = 0
        try {
            for (;;) {
                const part = await reader.read(); signal.throwIfAborted()
                if (part.done) break
                size += part.value.byteLength
                if (size > 262_144) throw unavailable()
                chunks.push(part.value)
            }
            if (!response.ok) throw unavailable()
            const parsed = projection.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            if (parsed.engineAgentId !== engineAgentId) throw unavailable()
            owners = new Map(parsed.owners.map(owner => [owner.slug, owner.name]))
        } finally { void reader.cancel().catch(() => {}) }
    }
    // Unacknowledged, legacy and forged resources in the reserved namespace stay protected.
    const entries = await readdir(/* turbopackIgnore: true */ join(/* turbopackIgnore: true */ dirname(workspace), 'skills')).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw unavailable()
    })
    if (entries.length > 10_000) throw unavailable()
    for (const slug of entries) if (reservedServiceSkill(slug)) owners.set(slug, owners.get(slug) ?? 'App')
    signal.throwIfAborted()
    return owners
}

export async function assertUserSkillOperation(workspace: string, slug: string, signal?: AbortSignal): Promise<void> {
    if (!desktopSkillAuthorityRequired()) return
    if (reservedServiceSkill(slug) || (await trustedSkillOwners(workspace, signal)).has(slug)) throw new Error('This skill is managed by its app and cannot be changed or exported.')
}
