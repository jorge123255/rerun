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

const FLIGHTS = Symbol.for('rerun.desktop.github-projects.flights.v1')
const QUEUES = Symbol.for('rerun.desktop.github-projects.edits.v1')
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

    async function run(chat: DesktopForemanChatRef, key: string, repositories: DesktopGithubRepositoryRef[], signal: AbortSignal): Promise<DesktopGithubProjectsRecord> {
        const reads = await readGithubRepositories(repositories, ports.read, signal)
        signal.throwIfAborted()
        const data = reads.flatMap(read => read.ok ? [read.data] : [])
        let outcome: DesktopGithubProjectsEngineOutcome | null = null
        let note: string | null = null
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
