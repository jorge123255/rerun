import 'server-only'
import {
    DESKTOP_GITHUB_PROJECT_LIMITS,
    applyGithubProjectsEdit,
    desktopGithubProjectsEditSchema,
    githubRepositoryLinksMessage,
    parseGithubRepositoryLinks,
    type CompanyBriefModelRef,
    type DesktopForemanChatRef,
    type DesktopGithubProject,
    type DesktopGithubProjectLink,
    type DesktopGithubProjectsEdit,
    type DesktopGithubProjectsEngineInput,
    type DesktopGithubProjectsEngineOutcome,
    type DesktopGithubProjectsRecord,
    type DesktopGithubRepositoryData,
    type DesktopGithubRepositoryRef,
} from '@rerun/contracts'
import {
    defaultProjectRoles,
    detectExplicitProjectLinks,
    detectProjectBuild,
    detectProjectKind,
    detectProjectStack,
    readGithubRepositories,
    type GithubApiReader,
} from '../../../../../engine/src/desktop/github-projects/index.ts'
import { DesktopHttpError } from '../auth'
import { desktopGithubLinksKey, type DesktopGithubProjectsStore } from './store'

export type DesktopGithubProjectsPorts = {
    store: DesktopGithubProjectsStore
    /** Reads api.github.com. Tests supply a synthetic one. */
    read: GithubApiReader
    /** The model the intake already uses for the website read; null when it does not support this. */
    model(chat: DesktopForemanChatRef): Promise<CompanyBriefModelRef | null>
    understand(input: DesktopGithubProjectsEngineInput, signal: AbortSignal): Promise<DesktopGithubProjectsEngineOutcome>
    now?: () => string
}

export type DesktopGithubProjectsAnswer = { record: DesktopGithubProjectsRecord | null; message: string | null }

const NO_MODEL = 'The selected model does not support this read, so only what the files show is listed.'
const MODEL_FAILED = 'The model could not describe these projects, so only what the files show is listed.'
const FILES_ONLY = 'Read from the links in your message. Your model is describing these projects; until it has, only what the files show is listed.'

function oneLine(value: string | null, max: number): string | null {
    const cleaned = value?.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim()
    if (!cleaned) return null
    return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned
}

/** Files decide first; the model fills what they leave open; the rest stays empty. */
export function buildGithubProjectsRecord(input: {
    key: string
    repositories: readonly DesktopGithubRepositoryRef[]
    reads: Awaited<ReturnType<typeof readGithubRepositories>>
    outcome: DesktopGithubProjectsEngineOutcome | null
    note: string | null
    now: string
}): DesktopGithubProjectsRecord {
    const understood = input.outcome?.status === 'succeeded' ? input.outcome : null
    const data: DesktopGithubRepositoryData[] = input.reads.flatMap(read => read.ok ? [read.data] : [])
    const projects: DesktopGithubProject[] = input.repositories.map(ref => {
        const read = input.reads.find(item => item.ref.id === ref.id)
        const base = { id: ref.id, owner: ref.owner, name: ref.name, url: ref.url, removed: false }
        if (!read || !read.ok) {
            return { ...base, state: 'unavailable', failure: read && !read.ok ? read.failure : 'failed', kind: 'other', kindSource: 'default', purpose: null, stack: [], build: null, suggestedRoles: [], roles: [] }
        }
        const said = understood?.projects.find(project => project.id === ref.id) ?? null
        const fromFiles = detectProjectKind(read.data)
        const kind = fromFiles ?? said?.kind ?? 'other'
        const stack = [...detectProjectStack(read.data)]
        for (const item of said?.stack ?? []) if (!stack.some(known => known.toLowerCase() === item.toLowerCase())) stack.push(item)
        const roles = said && said.roles.length >= 2 ? said.roles : defaultProjectRoles(kind)
        return {
            ...base, state: 'read', failure: null, kind,
            kindSource: fromFiles ? 'manifest' : said?.kind ? 'model' : 'default',
            purpose: said?.purpose ?? oneLine(read.data.description, DESKTOP_GITHUB_PROJECT_LIMITS.purpose),
            stack: stack.slice(0, DESKTOP_GITHUB_PROJECT_LIMITS.stackItems),
            build: detectProjectBuild(read.data) ?? said?.build ?? null,
            suggestedRoles: roles, roles,
        }
    })
    const read = new Set(data.map(item => item.id))
    const links: DesktopGithubProjectLink[] = detectExplicitProjectLinks(data)
    for (const link of understood?.links ?? []) {
        if (!read.has(link.from) || !read.has(link.to) || links.length >= DESKTOP_GITHUB_PROJECT_LIMITS.maxLinks) continue
        // What the repositories state themselves stands; the model only adds a pair nothing else linked.
        if (links.some(known => (known.from === link.from && known.to === link.to) || (known.from === link.to && known.to === link.from))) continue
        links.push({ from: link.from, to: link.to, kind: link.kind, source: 'model', quote: link.quote })
    }
    return { key: input.key, revision: 0, inference: understood ? 'model' : 'none', inferenceNote: understood ? null : input.note, projects, links, readAt: input.now, updatedAt: input.now }
}

/**
 * A set that grew by a link keeps what was already settled for the projects it had: their kind,
 * their description, the roles the owner left ticked and the links between them.
 */
export function carryGithubProjectEdits(fresh: DesktopGithubProjectsRecord, before: DesktopGithubProjectsRecord | null): DesktopGithubProjectsRecord {
    if (!before) return fresh
    const projects = fresh.projects.map(project => {
        const known = before.projects.find(item => item.id === project.id && !item.removed && item.state === 'read')
        if (!known || project.state !== 'read') return project
        return { ...project, kind: known.kind, kindSource: known.kindSource, purpose: known.purpose ?? project.purpose, stack: known.stack.length ? known.stack : project.stack, build: known.build ?? project.build, suggestedRoles: known.suggestedRoles, roles: known.roles }
    })
    const read = new Set(projects.filter(project => project.state === 'read').map(project => project.id))
    const links = [...fresh.links]
    for (const link of before.links) {
        if (!read.has(link.from) || !read.has(link.to) || links.length >= DESKTOP_GITHUB_PROJECT_LIMITS.maxLinks) continue
        if (links.some(known => (known.from === link.from && known.to === link.to) || (known.from === link.to && known.to === link.from))) continue
        links.push(link)
    }
    return { ...fresh, projects, links }
}

/**
 * What the model says about projects that were first read from their files alone, laid over the
 * saved record: it fills what the files left open and never undoes what the owner changed since.
 * A kind the files decided or the owner chose stands; roles the owner ticked or unticked stand.
 */
export function describeGithubProjects(record: DesktopGithubProjectsRecord, outcome: Extract<DesktopGithubProjectsEngineOutcome, { status: 'succeeded' }>): DesktopGithubProjectsRecord {
    const projects = record.projects.map(project => {
        const said = outcome.projects.find(item => item.id === project.id)
        if (!said || project.state !== 'read') return project
        const kind = project.kindSource === 'default' && said.kind ? said.kind : project.kind
        const stack = [...project.stack]
        for (const item of said.stack) if (!stack.some(known => known.toLowerCase() === item.toLowerCase())) stack.push(item)
        const untouched = project.roles.length === project.suggestedRoles.length && project.roles.every(role => project.suggestedRoles.includes(role))
        const roles = said.roles.length >= 2 ? said.roles : kind !== project.kind ? defaultProjectRoles(kind) : project.suggestedRoles
        return {
            ...project, kind, kindSource: kind !== project.kind ? 'model' as const : project.kindSource,
            purpose: project.purpose ?? said.purpose, stack: stack.slice(0, DESKTOP_GITHUB_PROJECT_LIMITS.stackItems), build: project.build ?? said.build ?? null,
            suggestedRoles: roles, roles: untouched ? roles : project.roles,
        }
    })
    const read = new Set(projects.filter(project => project.state === 'read' && !project.removed).map(project => project.id))
    const links = [...record.links]
    for (const link of outcome.links) {
        if (!read.has(link.from) || !read.has(link.to) || links.length >= DESKTOP_GITHUB_PROJECT_LIMITS.maxLinks) continue
        if (links.some(known => (known.from === link.from && known.to === link.to) || (known.from === link.to && known.to === link.from))) continue
        links.push({ from: link.from, to: link.to, kind: link.kind, source: 'model', quote: link.quote })
    }
    return { ...record, inference: 'model', inferenceNote: null, projects, links }
}

const FLIGHTS = Symbol.for('rerun.desktop.github-projects.flights.v1')
const QUEUES = Symbol.for('rerun.desktop.github-projects.edits.v1')
const DESCRIBING = Symbol.for('rerun.desktop.github-projects.describing.v1')
const describing = () => ((globalThis as unknown as Record<symbol, Map<string, Promise<void>>>)[DESCRIBING] ??= new Map())
const queues = () => ((globalThis as unknown as Record<symbol, Map<string, Promise<unknown>>>)[QUEUES] ??= new Map())
const flights = () => ((globalThis as unknown as Record<symbol, Map<string, Promise<DesktopGithubProjectsRecord>>>)[FLIGHTS] ??= new Map())

export function createDesktopGithubProjectsService(ports: DesktopGithubProjectsPorts, scope = '') {
    const now = () => ports.now?.() ?? new Date().toISOString()
    // Edits to one conversation are applied one after another, whichever request brings them.
    const inOrder = <T>(chat: DesktopForemanChatRef, work: () => Promise<T>): Promise<T> => {
        const queueKey = JSON.stringify([scope, chat.workspaceId, chat.chatId])
        const next = (queues().get(queueKey) ?? Promise.resolve()).then(work, work)
        const settled = next.catch(() => {}).finally(() => { if (queues().get(queueKey) === settled) queues().delete(queueKey) })
        queues().set(queueKey, settled)
        return next
    }

    const describeKey = (chat: DesktopForemanChatRef, key: string) => JSON.stringify([scope, chat.workspaceId, chat.chatId, key, 'describe'])
    function describeLater(chat: DesktopForemanChatRef, key: string, data: DesktopGithubRepositoryData[]) {
        const flightKey = describeKey(chat, key)
        if (describing().has(flightKey)) return
        const work = (async () => {
            const model = await ports.model(chat).catch(() => null)
            if (!model) return
            const outcome = await ports.understand({ model, repositories: data }, AbortSignal.timeout(DESKTOP_GITHUB_PROJECT_LIMITS.modelDeadlineMs + 15_000)).catch(() => null)
            if (outcome?.status !== 'succeeded') return
            // Laid over the record as it is now, in line with the owner's edits, and only while this set is still the current one.
            await inOrder(chat, async () => {
                const current = await ports.store.current(chat)
                if (!current || current.key !== key || current.inference === 'model') return
                await ports.store.save(chat, { ...describeGithubProjects(current, outcome), revision: current.revision + 1, updatedAt: now() })
            })
        })().catch(() => {}).finally(() => { if (describing().get(flightKey) === work) describing().delete(flightKey) })
        describing().set(flightKey, work)
    }

    async function run(chat: DesktopForemanChatRef, key: string, repositories: DesktopGithubRepositoryRef[], signal: AbortSignal, quick?: { carry: DesktopGithubProjectsRecord | null }): Promise<DesktopGithubProjectsRecord> {
        const reads = await readGithubRepositories(repositories, ports.read, signal)
        signal.throwIfAborted()
        const data = reads.flatMap(read => read.ok ? [read.data] : [])
        let outcome: DesktopGithubProjectsEngineOutcome | null = null
        let note: string | null = null
        if (quick) {
            // A message is answered at once: the files are read and no model is asked.
            const fresh = buildGithubProjectsRecord({ key, repositories, reads, outcome: null, note: data.length ? FILES_ONLY : null, now: now() })
            const record = carryGithubProjectEdits(fresh, quick.carry)
            await ports.store.save(chat, record)
            // The model's description follows on its own and is laid over whatever is saved by then.
            if (data.length) describeLater(chat, key, data)
            return record
        }
        if (data.length) {
            // A model the research step does not support gets no inference, and no other account is used.
            const model = await ports.model(chat).catch(() => null)
            if (!model) note = NO_MODEL
            else {
                outcome = await ports.understand({ model, repositories: data }, signal).catch(() => null)
                if (outcome?.status !== 'succeeded') note = MODEL_FAILED
            }
        }
        signal.throwIfAborted()
        const record = buildGithubProjectsRecord({ key, repositories, reads, outcome, note, now: now() })
        await ports.store.save(chat, record)
        return record
    }

    return {
        /** The set in the field now, with the owner's edits. Reading starts nothing. */
        read: (chat: DesktopForemanChatRef) => ports.store.current(chat),

        /**
         * Reads the listed repositories, or returns the saved reading of this exact set. `again`
         * reads GitHub afresh and replaces the saved reading, the owner's edits included.
         */
        async analyze(chat: DesktopForemanChatRef, input: string, options?: { again?: boolean; signal?: AbortSignal }): Promise<DesktopGithubProjectsAnswer> {
            if (input.length > DESKTOP_GITHUB_PROJECT_LIMITS.maxInput) throw new DesktopHttpError(400, 'That is too much text for the GitHub repositories field.')
            const reading = parseGithubRepositoryLinks(input)
            const message = githubRepositoryLinksMessage(reading)
            if (!reading.repositories.length) {
                await ports.store.clear(chat)
                return { record: null, message }
            }
            const key = desktopGithubLinksKey(reading.repositories)
            if (!options?.again) {
                const saved = await ports.store.byKey(chat, key)
                if (saved) { await ports.store.save(chat, saved); return { record: saved, message } }
            }
            const flightKey = JSON.stringify([scope, chat.workspaceId, chat.chatId, key])
            let flight = flights().get(flightKey)
            if (!flight) {
                // The read is not tied to the request that started it: closing the panel does not waste it.
                const deadline = AbortSignal.timeout(DESKTOP_GITHUB_PROJECT_LIMITS.runDeadlineMs + DESKTOP_GITHUB_PROJECT_LIMITS.modelDeadlineMs + 15_000)
                flight = run(chat, key, reading.repositories, deadline).finally(() => { if (flights().get(flightKey) === flight) flights().delete(flightKey) })
                flights().set(flightKey, flight)
            }
            return { record: await flight, message }
        },

        /**
         * Repositories linked in a chat message: they join the conversation's set and the set is read
         * from the files alone, so the message is not kept waiting on a model. `pending` says the
         * read was still running after `waitMs`; it carries on and is saved when it ends.
         */
        async mention(chat: DesktopForemanChatRef, mentioned: readonly DesktopGithubRepositoryRef[], waitMs: number): Promise<{ record: DesktopGithubProjectsRecord | null; pending: boolean }> {
            const current = await ports.store.current(chat)
            const kept: DesktopGithubRepositoryRef[] = (current?.projects ?? []).filter(project => !project.removed).map(({ id, owner, name, url }) => ({ id, owner, name, url }))
            const repositories = [...kept]
            for (const repository of mentioned) {
                if (repositories.length >= DESKTOP_GITHUB_PROJECT_LIMITS.maxRepositories) break
                if (!repositories.some(known => known.id === repository.id)) repositories.push(repository)
            }
            if (!repositories.length) return { record: null, pending: false }
            // Nothing new was named: the saved reading, with the owner's edits, stands.
            if (current && repositories.length === kept.length) return { record: current, pending: false }
            const key = desktopGithubLinksKey(repositories)
            const flightKey = JSON.stringify([scope, chat.workspaceId, chat.chatId, key, 'files'])
            let flight = flights().get(flightKey)
            if (!flight) {
                const deadline = AbortSignal.timeout(DESKTOP_GITHUB_PROJECT_LIMITS.runDeadlineMs + 15_000)
                flight = run(chat, key, repositories, deadline, { carry: current }).finally(() => { if (flights().get(flightKey) === flight) flights().delete(flightKey) })
                flights().set(flightKey, flight)
            }
            let timer: ReturnType<typeof setTimeout> | undefined
            const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), waitMs) })
            try {
                const record = await Promise.race([flight.catch(() => null), late])
                if (record === null) return { record, pending: flights().get(flightKey) === flight }
                // Whatever is left of the wait goes to the model's description, so the first answer can use it.
                const described = describing().get(describeKey(chat, key))
                if (described) await Promise.race([described, late])
                return { record: await ports.store.current(chat) ?? record, pending: false }
            } finally { clearTimeout(timer) }
        },

        /** One review edit by the owner, on the set they were shown. */
        edit(chat: DesktopForemanChatRef, key: string, raw: DesktopGithubProjectsEdit): Promise<DesktopGithubProjectsRecord> {
            const edit = desktopGithubProjectsEditSchema.parse(raw)
            return inOrder(chat, async () => {
                const current = await ports.store.current(chat)
                if (!current || current.key !== key) throw new DesktopHttpError(409, 'These GitHub projects changed. Review the current list.')
                const next = applyGithubProjectsEdit(current, edit)
                if (next === current) return current
                const saved = { ...next, revision: current.revision + 1, updatedAt: now() }
                await ports.store.save(chat, saved)
                return saved
            })
        },

        async clear(chat: DesktopForemanChatRef): Promise<void> { await ports.store.clear(chat) },
    }
}
export type DesktopGithubProjectsService = ReturnType<typeof createDesktopGithubProjectsService>
