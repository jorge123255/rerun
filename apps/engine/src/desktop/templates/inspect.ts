import { lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
    DESKTOP_TEMPLATE_LIMITS,
    SELF_IMPROVEMENT_KEYS,
    TOOL_KEYS,
    desktopTemplateSkillSlugSchema,
    isSetupAnswered,
    scanTextForSecrets,
    type DesktopTemplateExclusion,
    type DesktopTemplateExclusionReason,
} from '@rerun/contracts'
import { TemplateRequestError } from './errors.js'
import { desktopSkillAuthorityRequired, trustedSkillOwners } from '../service-skills/authority.js'
import { readConfined, walkConfined } from './files.js'
import { canonicalJson, sha256 } from './hash.js'

const VERBOSITY = new Set(['minimal', 'concise', 'normal', 'detailed'])
const ROOT_EXCLUSIONS: { path: string; reason: DesktopTemplateExclusionReason }[] = [
    { path: '.env', reason: 'credentials' },
    { path: 'memory', reason: 'memory' },
    { path: 'data', reason: 'database' },
    { path: 'mcp', reason: 'credentials' },
    { path: 'schedules', reason: 'routine' },
    { path: 'triggers', reason: 'webhook' },
    { path: 'sessions', reason: 'history' },
    { path: 'runs', reason: 'history' },
    { path: 'history', reason: 'history' },
    { path: 'workspace/.rerun', reason: 'service-registry' },
]

export type InspectedFile = {
    path: string
    bytes: number
    text: string
    inodeRevision: string
    contentRevision: string
    flagged: string[]
}

export type InspectedSkill = {
    slug: string
    name: string
    description: string
    sourceRevision: string
    files: InspectedFile[]
}

export type InspectedCoworker = {
    engineAgentId: string
    localAgentId: string
    name: string
    description: string
    sourceRevision: string
    setup: { required: boolean | null; prompt: string; answered: boolean }
    soul: InspectedFile | null
    install: InspectedFile | null
    config: InspectedFile | null
    strippedConfigKeys: string[]
    selectableFiles: InspectedFile[]
    selectableSkills: InspectedSkill[]
    exclusions: DesktopTemplateExclusion[]
    redactions: { path: string; reason: string }[]
    blocked: string | null
}

function agentFolder(agentsRoot: string, engineAgentId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(engineAgentId)) throw new TemplateRequestError(400, 'Invalid coworker')
    const root = resolve(agentsRoot)
    const folder = resolve(root, engineAgentId)
    const rel = relative(root, folder)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.includes(sep)) {
        throw new TemplateRequestError(400, 'Invalid coworker')
    }
    return folder
}

function flagged(text: string): string[] {
    return [...new Set(scanTextForSecrets(text))].slice(0, 20)
}

async function existsKind(path: string): Promise<'file' | 'dir' | 'link' | 'other' | 'absent'> {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!info) return 'absent'
    if (info.isSymbolicLink()) return 'link'
    if (info.isDirectory()) return 'dir'
    if (info.isFile()) return 'file'
    return 'other'
}

function skillMeta(text: string, slug: string): { name: string; description: string } {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!match?.[1]) return { name: slug, description: '' }
    const block = match[1]
    const read = (key: string) => {
        const found = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(block)?.[1]?.trim() ?? ''
        return found.replace(/^['"]|['"]$/g, '').slice(0, key === 'name' ? 200 : 2_000)
    }
    return { name: read('name') || slug, description: read('description') }
}

function scrubConfig(raw: unknown, fallbackName: string): { text: string; name: string; description: string; stripped: string[]; setupRequired: boolean | null } | { error: string } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'config.json is not an object' }
    const source = raw as Record<string, unknown>
    const display = typeof source.displayName === 'string' ? source.displayName.trim() : ''
    const name = (display || (typeof source.name === 'string' ? source.name.trim() : '') || fallbackName).slice(0, 60)
    if (!name) return { error: 'config.json has no coworker name' }
    const description = (typeof source.description === 'string' ? source.description : '').slice(0, 2_000)
    const verbosity = typeof source.verbosity === 'string' && VERBOSITY.has(source.verbosity) ? source.verbosity : 'normal'
    const setup = source.setup && typeof source.setup === 'object' ? source.setup as Record<string, unknown> : {}
    const setupRequired = typeof setup.required === 'boolean' ? setup.required : null
    const tools = Object.fromEntries(TOOL_KEYS.map(key => [key, false]))
    const selfImprovement = Object.fromEntries(SELF_IMPROVEMENT_KEYS.map(key => [key, false]))
    const next = {
        name: typeof source.name === 'string' && source.name.trim() ? source.name.trim().slice(0, 128) : name,
        kind: 'user',
        ephemeral: false,
        enabled: true,
        displayName: name,
        description,
        connectionId: null,
        provider: null,
        model: null,
        verbosity,
        tools,
        mcpServers: [],
        selfImprovement,
        setup: { required: null, completedAt: null, sessionId: null },
    }
    const stripped: string[] = []
    if (source.connectionId) stripped.push('connectionId')
    if (source.provider) stripped.push('provider')
    if (source.model) stripped.push('model')
    if (Array.isArray(source.mcpServers) && source.mcpServers.length > 0) stripped.push('mcpServers')
    const sourceTools = source.tools && typeof source.tools === 'object' ? source.tools as Record<string, unknown> : {}
    if (TOOL_KEYS.some(key => sourceTools[key] === true)) stripped.push('tools')
    if (sourceTools.desktopToolGrants || sourceTools.desktopCodexGrants) stripped.push('nativeGrants')
    if ('selfImprovement' in source) stripped.push('selfImprovement')
    return { text: `${JSON.stringify(next, null, 2)}\n`, name, description, stripped, setupRequired }
}

export async function inspectCoworker(agentsRoot: string, localAgentId: string, engineAgentId: string): Promise<InspectedCoworker> {
    const folder = agentFolder(agentsRoot, engineAgentId)
    const kind = await existsKind(folder)
    if (kind === 'absent') throw new TemplateRequestError(404, 'Source coworker not found')
    if (kind !== 'dir') throw new TemplateRequestError(409, 'Source coworker folder is not a plain directory')

    const exclusions: DesktopTemplateExclusion[] = []
    for (const root of ROOT_EXCLUSIONS) {
        const found = await existsKind(resolve(folder, root.path))
        if (found === 'absent') continue
        exclusions.push({ path: root.path, reason: found === 'link' ? 'link' : root.reason })
    }

    const limits = DESKTOP_TEMPLATE_LIMITS
    const soulRead = await readConfined(folder, 'SOUL.md', limits.maxFileBytes)
    const installRead = await readConfined(folder, 'INSTALL.md', limits.maxFileBytes)
    const configRead = await readConfined(folder, 'config.json', limits.maxFileBytes)
    const asFile = (path: string, read: Extract<typeof soulRead, { ok: true }>): InspectedFile => ({
        path, bytes: read.bytes.length, text: read.text, inodeRevision: read.inodeRevision, contentRevision: read.contentRevision, flagged: flagged(read.text),
    })
    const soul = soulRead.ok ? asFile('SOUL.md', soulRead) : null
    const install = installRead.ok ? asFile('INSTALL.md', installRead) : null
    if (!soulRead.ok && (await existsKind(resolve(folder, 'SOUL.md'))) !== 'absent') exclusions.push({ path: 'SOUL.md', reason: soulRead.reason })
    if (!installRead.ok && (await existsKind(resolve(folder, 'INSTALL.md'))) !== 'absent') exclusions.push({ path: 'INSTALL.md', reason: installRead.reason })

    let config: InspectedFile | null = null
    let strippedConfigKeys: string[] = []
    let name = 'Coworker'
    let description = ''
    let setupRequired: boolean | null = null
    let blocked: string | null = null
    if (!configRead.ok) {
        blocked = 'config.json cannot be captured'
        if ((await existsKind(resolve(folder, 'config.json'))) !== 'absent') exclusions.push({ path: 'config.json', reason: configRead.reason })
    } else {
        let parsed: unknown
        try { parsed = JSON.parse(configRead.text) } catch { parsed = null }
        const scrubbed = scrubConfig(parsed, name)
        if ('error' in scrubbed) blocked = scrubbed.error
        else {
            const text = scrubbed.text
            if (Buffer.byteLength(text) > limits.maxFileBytes) blocked = 'Scrubbed config.json exceeds the capture limit'
            else {
                name = scrubbed.name
                description = scrubbed.description
                strippedConfigKeys = scrubbed.stripped
                setupRequired = scrubbed.setupRequired
                config = {
                    path: 'config.json',
                    bytes: Buffer.byteLength(text),
                    text,
                    inodeRevision: configRead.inodeRevision,
                    contentRevision: sha256(text),
                    flagged: flagged(text),
                }
            }
        }
    }

    const redactions = config ? [{ path: 'config.json', reason: 'Removed connection, provider, model, MCP servers, native grants, and turned every tool off.' }] : []
    const prompt = install?.text ?? ''
    const setup = { required: setupRequired, prompt, answered: isSetupAnswered({ required: setupRequired, prompt }) }
    if (setup.required === true && !setup.answered) blocked = blocked ?? 'A coworker that needs setup must include INSTALL.md instructions'

    const selectableFiles: InspectedFile[] = []
    if ((await existsKind(resolve(folder, 'workspace'))) === 'link') exclusions.push({ path: 'workspace', reason: 'link' })
    const workspace = await walkConfined(folder, 'workspace', limits.maxWalkEntries)
    if (workspace.truncated) blocked = blocked ?? 'This coworker has too many files to capture'
    for (const entry of workspace.entries) {
        if (entry.path === 'workspace/.rerun' || entry.path.startsWith('workspace/.rerun/')) continue
        if (entry.kind !== 'file') {
            exclusions.push({ path: entry.path, reason: entry.kind === 'link' ? 'link' : 'unsupported' })
            continue
        }
        const read = await readConfined(folder, entry.path, limits.maxFileBytes)
        if (!read.ok) { exclusions.push({ path: entry.path, reason: read.reason }); continue }
        selectableFiles.push(asFile(entry.path, read))
    }

    const selectableSkills: InspectedSkill[] = []
    if ((await existsKind(resolve(folder, 'skills'))) === 'link') exclusions.push({ path: 'skills', reason: 'link' })
    const owners = await connectorOwners(folder, exclusions)
    const skillWalk = await walkConfined(folder, 'skills', limits.maxWalkEntries)
    if (skillWalk.truncated) blocked = blocked ?? 'This coworker has too many skill files to capture'
    const bySlug = new Map<string, WalkEntryLike[]>()
    for (const entry of skillWalk.entries) {
        const slug = entry.path.split('/')[1]
        // The native read lease creates this inert lock; its presence cannot alter a capture plan.
        if (!slug || slug === '.rerun-skill-lock') continue
        const list = bySlug.get(slug) ?? []
        list.push(entry)
        bySlug.set(slug, list)
    }
    for (const [slug, entries] of [...bySlug.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        if (!desktopTemplateSkillSlugSchema.safeParse(slug).success) {
            exclusions.push({ path: `skills/${slug}`, reason: 'unsupported' })
            continue
        }
        if (slug.startsWith('svc-') || owners?.has(slug)) {
            exclusions.push({ path: `skills/${slug}`, reason: 'connector-skill' })
            continue
        }
        if (owners === null) {
            exclusions.push({ path: `skills/${slug}`, reason: 'unsupported' })
            continue
        }
        const files: InspectedFile[] = []
        let skillBlocked = false
        for (const entry of entries) {
            if (entry.kind !== 'file') {
                exclusions.push({ path: entry.path, reason: entry.kind === 'link' ? 'link' : 'unsupported' })
                skillBlocked = true
                continue
            }
            const read = await readConfined(folder, entry.path, limits.maxFileBytes)
            if (!read.ok) { exclusions.push({ path: entry.path, reason: read.reason }); skillBlocked = true; continue }
            files.push(asFile(entry.path, read))
        }
        if (skillBlocked || !files.some(file => file.path === `skills/${slug}/SKILL.md`)) {
            if (!files.some(file => file.path === `skills/${slug}/SKILL.md`)) exclusions.push({ path: `skills/${slug}`, reason: 'unsupported' })
            continue
        }
        const skillFile = files.find(file => file.path.endsWith('/SKILL.md'))!
        const meta = skillMeta(skillFile.text, slug)
        const sourceRevision = sha256(canonicalJson(files.map(file => [file.path, file.contentRevision])))
        selectableSkills.push({ slug, name: meta.name, description: meta.description, sourceRevision, files })
    }

    const identity = [
        ['SOUL.md', soul?.contentRevision ?? ''],
        ['INSTALL.md', install?.contentRevision ?? ''],
        ['config.json', config?.contentRevision ?? ''],
        ...selectableFiles.map(file => [file.path, file.contentRevision] as const),
        ...selectableSkills.map(skill => [skill.slug, skill.sourceRevision] as const),
    ]
    return {
        engineAgentId, localAgentId, name, description,
        sourceRevision: sha256(canonicalJson(identity)),
        setup, soul, install, config, strippedConfigKeys, selectableFiles, selectableSkills,
        exclusions, redactions, blocked,
    }
}

type WalkEntryLike = { path: string; kind: 'file' | 'link' | 'other' }

async function connectorOwners(folder: string, exclusions: DesktopTemplateExclusion[]): Promise<Set<string> | null> {
    if (desktopSkillAuthorityRequired()) return new Set((await trustedSkillOwners(resolve(folder, 'workspace'))).keys())
    const path = 'workspace/.rerun/services.json'
    const kind = await existsKind(resolve(folder, path))
    if (kind === 'absent') return new Set()
    if (kind !== 'file') { exclusions.push({ path, reason: kind === 'link' ? 'link' : 'unsupported' }); return null }
    const read = await readConfined(folder, path, DESKTOP_TEMPLATE_LIMITS.maxFileBytes)
    if (!read.ok) { exclusions.push({ path, reason: read.reason }); return null }
    try {
        const parsed = JSON.parse(read.text) as { services?: Record<string, { skills?: unknown }> }
        const owners = new Set<string>()
        for (const entry of Object.values(parsed.services ?? {})) {
            if (!Array.isArray(entry?.skills)) continue
            for (const slug of entry.skills) if (typeof slug === 'string' && slug) owners.add(slug)
        }
        return owners
    } catch {
        exclusions.push({ path, reason: 'unsupported' })
        return null
    }
}
