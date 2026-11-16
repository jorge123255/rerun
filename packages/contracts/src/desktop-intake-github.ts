import { z } from 'zod'

import { companyBriefModelSchema } from './desktop-company-brief.js'

// GitHub projects in the Chief of Staff's first intake step (a Mac addition).
// The owner lists the repositories they work on; the app reads each public repository as data,
// works out what kind of project it is and how the projects relate, and shows that for review.
// Everything read from a repository is untrusted text written by other people: bounded here,
// passed to a model only as labelled data, and never an instruction.

export const DESKTOP_GITHUB_PROJECT_LIMITS = {
    /** Repositories in one intake. */
    maxRepositories: 12,
    /** Characters accepted in the field. */
    maxInput: 4000,
    /** README bytes kept from one repository. */
    readmeBytes: 20 * 1024,
    /** Bytes kept from one manifest file. */
    manifestBytes: 8 * 1024,
    /** Manifest files read from one repository. */
    maxManifests: 4,
    /** Top-level file names kept from one repository. */
    maxFiles: 200,
    maxTopics: 20,
    /** Requests to api.github.com in one read: under the 60 an hour GitHub allows without an account. */
    requestBudget: 54,
    requestDeadlineMs: 8_000,
    repositoryDeadlineMs: 20_000,
    runDeadlineMs: 60_000,
    modelDeadlineMs: 45_000,
    /** What the model is shown of one repository. */
    modelReadmeChars: 3000,
    modelManifestChars: 1500,
    modelFiles: 80,
    purpose: 200,
    build: 160,
    stackItems: 6,
    stackItem: 40,
    quote: 160,
    maxLinks: 24,
    /** The whole line handed to the Chief of Staff. */
    instructionChars: 9000,
} as const

export const DESKTOP_GITHUB_PROJECT_KINDS = ['ios-app', 'android-app', 'web-app', 'backend-service', 'library', 'cli', 'infrastructure', 'other'] as const
export type DesktopGithubProjectKind = (typeof DESKTOP_GITHUB_PROJECT_KINDS)[number]
export const DESKTOP_GITHUB_PROJECT_KIND_LABELS: Record<DesktopGithubProjectKind, string> = {
    'ios-app': 'Apple app', 'android-app': 'Android app', 'web-app': 'Web app', 'backend-service': 'Backend service',
    library: 'Library', cli: 'Command-line tool', infrastructure: 'Infrastructure', other: 'Other',
}

export const DESKTOP_GITHUB_PROJECT_ROLES = ['developer', 'qa-tester', 'release-manager', 'code-reviewer', 'docs-writer', 'support-triage'] as const
export type DesktopGithubProjectRole = (typeof DESKTOP_GITHUB_PROJECT_ROLES)[number]
export const DESKTOP_GITHUB_PROJECT_ROLE_LABELS: Record<DesktopGithubProjectRole, string> = {
    developer: 'Developer', 'qa-tester': 'QA tester', 'release-manager': 'Release manager',
    'code-reviewer': 'Code reviewer', 'docs-writer': 'Docs writer', 'support-triage': 'Support triage',
}

export const DESKTOP_GITHUB_LINK_KINDS = ['depends-on', 'companion'] as const
export type DesktopGithubLinkKind = (typeof DESKTOP_GITHUB_LINK_KINDS)[number]
export const DESKTOP_GITHUB_LINK_SOURCES = ['submodule', 'manifest', 'readme', 'model', 'owner'] as const
export type DesktopGithubLinkSource = (typeof DESKTOP_GITHUB_LINK_SOURCES)[number]
export const DESKTOP_GITHUB_LINK_SOURCE_LABELS: Record<DesktopGithubLinkSource, string> = {
    submodule: 'found in submodules', manifest: 'found in a package file', readme: 'found in README', model: 'suggested from the README', owner: 'added by you',
}

// GitHub's own rules: an owner is letters, digits and single hyphens; a repository name is letters,
// digits, dot, hyphen and underscore. Nothing else is ever put in a request path.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const NAME = /^[A-Za-z0-9._-]{1,100}$/

export type DesktopGithubRepositoryRef = { id: string; owner: string; name: string; url: string }

export function readGithubRepositoryLink(value: string): DesktopGithubRepositoryRef | null {
    const typed = value.trim()
    if (!typed || typed.length > 300) return null
    let url: URL
    try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`) } catch { return null }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.port) return null
    const host = url.hostname.toLowerCase()
    if (host !== 'github.com' && host !== 'www.github.com') return null
    const [owner, rawName] = url.pathname.split('/').filter(Boolean)
    if (!owner || !rawName) return null
    const name = rawName.replace(/\.git$/i, '')
    if (!OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') return null
    return { id: `${owner}/${name}`.toLowerCase(), owner, name, url: `https://github.com/${owner}/${name}` }
}

// Paths under github.com that are GitHub's own pages, not somebody's repositories.
const NOT_OWNERS = new Set(['orgs', 'settings', 'features', 'marketplace', 'sponsors', 'topics', 'about', 'login', 'apps', 'collections', 'explore', 'pricing', 'enterprise', 'notifications', 'pulls', 'issues', 'search'])

/**
 * The GitHub repositories linked in a chat message, in the order written, without repeats. Only a
 * full github.com link counts: a bare `owner/name` in a sentence is not read as a repository.
 */
export function githubRepositoryLinksInText(text: string): DesktopGithubRepositoryRef[] {
    const found: DesktopGithubRepositoryRef[] = []
    for (const match of text.slice(0, 20_000).matchAll(/https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+/gi)) {
        const repository = readGithubRepositoryLink(match[0].replace(/[.,;:!?'"]+$/, ''))
        if (!repository || NOT_OWNERS.has(repository.owner.toLowerCase()) || found.some(known => known.id === repository.id)) continue
        found.push(repository)
        if (found.length >= DESKTOP_GITHUB_PROJECT_LIMITS.maxRepositories) break
    }
    return found
}

export type DesktopGithubLinksReading = {
    repositories: DesktopGithubRepositoryRef[]
    /** Entries that are not a github.com repository link, as typed (cut short). */
    refused: string[]
    /** More than the limit were given: the extra ones were left out. */
    overLimit: boolean
}

/** One link per line, or separated by spaces or commas. Duplicates are removed, the order is kept. */
export function parseGithubRepositoryLinks(input: string): DesktopGithubLinksReading {
    const repositories: DesktopGithubRepositoryRef[] = []
    const refused: string[] = []
    let overLimit = false
    const seen = new Set<string>()
    for (const entry of input.slice(0, DESKTOP_GITHUB_PROJECT_LIMITS.maxInput).split(/[\s,;]+/)) {
        if (!entry) continue
        const repository = readGithubRepositoryLink(entry)
        if (!repository) { if (refused.length < 12) refused.push(entry.slice(0, 80)); continue }
        if (seen.has(repository.id)) continue
        if (repositories.length >= DESKTOP_GITHUB_PROJECT_LIMITS.maxRepositories) { overLimit = true; continue }
        seen.add(repository.id)
        repositories.push(repository)
    }
    return { repositories, refused, overLimit }
}

/** The plain message under the field for what was refused; null when everything was accepted. */
export function githubRepositoryLinksMessage(reading: DesktopGithubLinksReading): string | null {
    const parts: string[] = []
    if (reading.refused.length) parts.push(`Not a GitHub repository link: ${reading.refused.join(', ')}. Use links like https://github.com/owner/name.`)
    if (reading.overLimit) parts.push(`Only the first ${DESKTOP_GITHUB_PROJECT_LIMITS.maxRepositories} repositories are read.`)
    return parts.length ? parts.join(' ') : null
}

const idSchema = z.string().min(3).max(141).regex(/^[a-z0-9-]+\/[a-z0-9._-]+$/)
const kindSchema = z.enum(DESKTOP_GITHUB_PROJECT_KINDS)
const roleSchema = z.enum(DESKTOP_GITHUB_PROJECT_ROLES)
const rolesSchema = z.array(roleSchema).max(DESKTOP_GITHUB_PROJECT_ROLES.length)
const stackSchema = z.array(z.string().min(1).max(DESKTOP_GITHUB_PROJECT_LIMITS.stackItem)).max(DESKTOP_GITHUB_PROJECT_LIMITS.stackItems)

/** What was read from one repository, already cut to size. Untrusted text throughout. */
export const desktopGithubRepositoryDataSchema = z.strictObject({
    id: idSchema,
    description: z.string().max(400).nullable(),
    language: z.string().max(60).nullable(),
    topics: z.array(z.string().max(60)).max(DESKTOP_GITHUB_PROJECT_LIMITS.maxTopics),
    defaultBranch: z.string().max(120).nullable(),
    files: z.array(z.string().max(160)).max(DESKTOP_GITHUB_PROJECT_LIMITS.maxFiles),
    readme: z.string().max(DESKTOP_GITHUB_PROJECT_LIMITS.readmeBytes).nullable(),
    manifests: z.array(z.strictObject({ path: z.string().max(160), text: z.string().max(DESKTOP_GITHUB_PROJECT_LIMITS.manifestBytes) })).max(DESKTOP_GITHUB_PROJECT_LIMITS.maxManifests),
})
export type DesktopGithubRepositoryData = z.infer<typeof desktopGithubRepositoryDataSchema>

export const DESKTOP_GITHUB_READ_FAILURES = ['not_found', 'token_refused', 'rate_limited', 'timeout', 'failed'] as const
export type DesktopGithubReadFailure = (typeof DESKTOP_GITHUB_READ_FAILURES)[number]
export const DESKTOP_GITHUB_READ_FAILURE_COPY: Record<DesktopGithubReadFailure, string> = {
    not_found: 'Private or not found. For a private repository, sign in to GitHub in the Vault with an account that can see it, or add a read-only GitHub token in Settings, Tool services.',
    token_refused: 'GitHub refused the saved token. Replace it in Settings, Tool services.',
    rate_limited: 'GitHub is limiting reads from this network right now. Try again later.',
    timeout: 'GitHub took too long to answer. Try again.',
    failed: 'This repository could not be read.',
}

export const desktopGithubProjectSchema = z.strictObject({
    id: idSchema,
    owner: z.string().min(1).max(39),
    name: z.string().min(1).max(100),
    url: z.string().min(1).max(200),
    state: z.enum(['read', 'unavailable']),
    failure: z.enum(DESKTOP_GITHUB_READ_FAILURES).nullable(),
    kind: kindSchema,
    /** Who decided the kind: the files in the repository, the model, the owner, or nobody yet. */
    kindSource: z.enum(['manifest', 'model', 'owner', 'default']),
    purpose: z.string().min(1).max(DESKTOP_GITHUB_PROJECT_LIMITS.purpose).nullable(),
    stack: stackSchema,
    build: z.string().min(1).max(DESKTOP_GITHUB_PROJECT_LIMITS.build).nullable(),
    suggestedRoles: rolesSchema,
    /** The roles the owner left ticked. */
    roles: rolesSchema,
    removed: z.boolean(),
})
export type DesktopGithubProject = z.infer<typeof desktopGithubProjectSchema>

export const desktopGithubProjectLinkSchema = z.strictObject({
    from: idSchema,
    to: idSchema,
    kind: z.enum(DESKTOP_GITHUB_LINK_KINDS),
    source: z.enum(DESKTOP_GITHUB_LINK_SOURCES),
    /** A short passage copied from the repository that shows the link; null for the owner's own. */
    quote: z.string().min(1).max(DESKTOP_GITHUB_PROJECT_LIMITS.quote).nullable(),
})
export type DesktopGithubProjectLink = z.infer<typeof desktopGithubProjectLinkSchema>

export const desktopGithubProjectsRecordSchema = z.strictObject({
    /** Digest of the set of repository links. */
    key: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().min(0),
    /** Whether a model wrote the prose; 'none' leaves the deterministic reading only. */
    inference: z.enum(['model', 'none']),
    inferenceNote: z.string().max(200).nullable(),
    projects: z.array(desktopGithubProjectSchema).max(DESKTOP_GITHUB_PROJECT_LIMITS.maxRepositories),
    links: z.array(desktopGithubProjectLinkSchema).max(DESKTOP_GITHUB_PROJECT_LIMITS.maxLinks),
    readAt: z.string().min(1).max(40),
    updatedAt: z.string().min(1).max(40),
})
export type DesktopGithubProjectsRecord = z.infer<typeof desktopGithubProjectsRecordSchema>

export const desktopGithubProjectsEditSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('remove-repository'), id: idSchema }),
    z.strictObject({ type: z.literal('set-kind'), id: idSchema, kind: kindSchema }),
    z.strictObject({ type: z.literal('set-role'), id: idSchema, role: roleSchema, on: z.boolean() }),
    z.strictObject({ type: z.literal('add-link'), from: idSchema, to: idSchema, kind: z.enum(DESKTOP_GITHUB_LINK_KINDS) }),
    z.strictObject({ type: z.literal('remove-link'), from: idSchema, to: idSchema, kind: z.enum(DESKTOP_GITHUB_LINK_KINDS) }),
])
export type DesktopGithubProjectsEdit = z.infer<typeof desktopGithubProjectsEditSchema>

/** The owner's review edits. Pure: the same edit on the same record gives the same record. */
export function applyGithubProjectsEdit(record: DesktopGithubProjectsRecord, edit: DesktopGithubProjectsEdit): DesktopGithubProjectsRecord {
    const kept = (id: string) => record.projects.some(project => project.id === id && !project.removed)
    const sameLink = (link: DesktopGithubProjectLink, other: { from: string; to: string; kind: string }) => link.from === other.from && link.to === other.to && link.kind === other.kind
    if (edit.type === 'remove-repository') {
        if (!record.projects.some(project => project.id === edit.id)) return record
        return {
            ...record,
            projects: record.projects.map(project => project.id === edit.id ? { ...project, removed: true } : project),
            links: record.links.filter(link => link.from !== edit.id && link.to !== edit.id),
        }
    }
    if (edit.type === 'set-kind') {
        return { ...record, projects: record.projects.map(project => project.id === edit.id && !project.removed ? { ...project, kind: edit.kind, kindSource: 'owner' as const } : project) }
    }
    if (edit.type === 'set-role') {
        return {
            ...record,
            projects: record.projects.map(project => {
                if (project.id !== edit.id || project.removed) return project
                const without = project.roles.filter(role => role !== edit.role)
                // Kept in the order of the closed list, so the same ticks always read the same.
                return { ...project, roles: edit.on ? DESKTOP_GITHUB_PROJECT_ROLES.filter(role => role === edit.role || without.includes(role)) : without }
            }),
        }
    }
    if (edit.type === 'add-link') {
        if (edit.from === edit.to || !kept(edit.from) || !kept(edit.to)) return record
        if (record.links.some(link => sameLink(link, edit)) || record.links.length >= DESKTOP_GITHUB_PROJECT_LIMITS.maxLinks) return record
        return { ...record, links: [...record.links, { from: edit.from, to: edit.to, kind: edit.kind, source: 'owner', quote: null }] }
    }
    return { ...record, links: record.links.filter(link => !sameLink(link, edit)) }
}

/** One line of text per link, as the review shows it: "OpenFlix depends on DVR tuner: found in README". */
export function githubProjectLinkLine(link: DesktopGithubProjectLink, projects: readonly Pick<DesktopGithubProject, 'id' | 'name'>[]): string {
    const nameOf = (id: string) => projects.find(project => project.id === id)?.name ?? id
    return `${nameOf(link.from)} ${link.kind === 'depends-on' ? 'depends on' : 'pairs with'} ${nameOf(link.to)}: ${DESKTOP_GITHUB_LINK_SOURCE_LABELS[link.source]}`
}

// Engine request: the model pass over what was read. The same model rules as the website read.
export const desktopGithubProjectsEngineInputSchema = z.strictObject({
    model: companyBriefModelSchema,
    repositories: z.array(desktopGithubRepositoryDataSchema).min(1).max(DESKTOP_GITHUB_PROJECT_LIMITS.maxRepositories),
})
export type DesktopGithubProjectsEngineInput = z.infer<typeof desktopGithubProjectsEngineInputSchema>

export const desktopGithubProjectsEngineOutcomeSchema = z.discriminatedUnion('status', [
    z.strictObject({
        status: z.literal('succeeded'),
        projects: z.array(z.strictObject({
            id: idSchema,
            kind: kindSchema.nullable(),
            purpose: z.string().min(1).max(DESKTOP_GITHUB_PROJECT_LIMITS.purpose).nullable(),
            stack: stackSchema,
            build: z.string().min(1).max(DESKTOP_GITHUB_PROJECT_LIMITS.build).nullable(),
            roles: rolesSchema,
        })).max(DESKTOP_GITHUB_PROJECT_LIMITS.maxRepositories),
        links: z.array(z.strictObject({
            from: idSchema, to: idSchema, kind: z.enum(DESKTOP_GITHUB_LINK_KINDS),
            quote: z.string().min(1).max(DESKTOP_GITHUB_PROJECT_LIMITS.quote),
        })).max(DESKTOP_GITHUB_PROJECT_LIMITS.maxLinks),
    }),
    z.strictObject({ status: z.literal('unavailable'), reason: z.string().max(80) }),
    z.strictObject({ status: z.literal('cancelled') }),
    z.strictObject({ status: z.literal('error'), reason: z.string().max(80) }),
])
export type DesktopGithubProjectsEngineOutcome = z.infer<typeof desktopGithubProjectsEngineOutcomeSchema>
