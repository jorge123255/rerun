import {
    INTAKE_COPY,
    desktopCompanyProfileAttemptSchema,
    desktopCompanyProfileCancelInputSchema,
    desktopCompanyProfileDecideInputSchema,
    desktopCompanyProfileEnrichInputSchema,
    desktopCompanyProfileViewSchema,
    type DesktopCompanyIndustryDecision,
    type DesktopCompanyProfileAttempt,
    type DesktopCompanyProfileCanonicalContext,
    type DesktopCompanyProfileCorrection,
    type DesktopCompanyProfileEngineOutcome,
    type DesktopCompanyProfileEvidence,
    type DesktopCompanyProfileIdentity,
    type DesktopCompanyProfileKnownName,
    type DesktopCompanyProfileModelAuthority,
    type DesktopCompanyProfileOutcome,
    type DesktopCompanyProfileProgress,
    type DesktopCompanyProfileProjection,
    type DesktopCompanyProfileSourceProgress,
    type DesktopCompanyProfileTrustedActorAuthority,
    type DesktopCompanyProfileView,
    type DesktopForemanChatRef,
    type TemplateCategory,
} from '@rerun/contracts'
import type { DesktopCompanyProfileEngineClient } from './client'
import type { DesktopCompanyProfileCollector, DesktopCompanyProfileCollectorEvent } from './collector'
import { DesktopCompanyProfileError } from './errors'
import { companyProfileEvidenceFromDiscovery } from './evidence'
import {
    desktopCompanyProfileFingerprint,
    desktopCompanyProfileIdentities,
    desktopCompanyProfileInput,
    desktopCompanyProfileRequestId,
} from './identity'
import { projectDesktopCompanyProfile } from './projection'
import type { DesktopCompanyProfileStore } from './store'

export type DesktopCompanyProfileCanonicalAuthority = {
    read(chat: DesktopForemanChatRef): Promise<DesktopCompanyProfileCanonicalContext>
    require(identity: DesktopCompanyProfileIdentity, kind: 'decide' | 'enrich'): Promise<DesktopCompanyProfileCanonicalContext>
}

export type DesktopCompanyProfileServicePorts = {
    store: DesktopCompanyProfileStore
    canonical: DesktopCompanyProfileCanonicalAuthority
    models: { decision: DesktopCompanyProfileModelAuthority; profile: DesktopCompanyProfileModelAuthority }
    engine: DesktopCompanyProfileEngineClient
    collector: DesktopCompanyProfileCollector
    actor: DesktopCompanyProfileTrustedActorAuthority
    now?: () => string
}

export function createDesktopCompanyProfileService(ports: DesktopCompanyProfileServicePorts) {
    const flights = new Map<string, Promise<DesktopCompanyProfileAttempt>>()
    const identityFlights = new Map<string, Promise<DesktopCompanyProfileAttempt>>()
    const controllers = new Map<string, AbortController>()
    const now = () => ports.now?.() ?? new Date().toISOString()
    let closed = false
    let closing: Promise<void> | null = null

    function assertOpen(): void {
        if (closed) throw new DesktopCompanyProfileError('closed', 'Company profile inference is closed.')
    }

    async function existing(requestId: string, fingerprint: string): Promise<DesktopCompanyProfileAttempt | null> {
        const row = await ports.store.get(requestId)
        if (!row) return null
        if (row.fingerprint !== fingerprint) throw new DesktopCompanyProfileError('conflict', 'This company profile request ID belongs to different input.')
        return row.attempt
    }

    async function run(
        kind: 'decide' | 'enrich',
        identity: DesktopCompanyProfileIdentity,
        collect: boolean,
        parent: AbortSignal | undefined,
        work: (requestId: string) => string,
    ): Promise<DesktopCompanyProfileAttempt> {
        assertOpen()
        const fingerprint = desktopCompanyProfileFingerprint(kind, identity, collect)
        const requestId = work(fingerprint)
        const prior = await existing(requestId, fingerprint)
        assertOpen()
        if (prior) return prior
        const latest = await ports.store.latest(identity.chat, kind)
        assertOpen()
        if (latest?.status === 'succeeded' && sameIdentity(latest.identity, identity)) return latest
        const identityKey = `${kind}:${identity.chat.workspaceId}:${identity.chat.chatId}:${identity.draftRevision}:${identity.inputDigest}`
        const current = identityFlights.get(identityKey)
        if (current) return current
        const flight = (async () => {
            const controller = new AbortController()
            controllers.set(requestId, controller)
            const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
            const stop = () => controller.abort()
            parent?.addEventListener('abort', stop, { once: true })
            try {
                await ports.canonical.read(identity.chat)
                assertOpen()
                signal.throwIfAborted()
                const createdAt = now()
                const attempt = desktopCompanyProfileAttemptSchema.parse({
                    contractVersion: 1, requestId, kind, identity, status: 'pending',
                    progress: { stage: 'queued', sources: [], updatedAt: createdAt },
                    outcome: null, evidence: [], modelCalled: false, createdAt, updatedAt: createdAt,
                })
                const inserted = await ports.store.insert(attempt, fingerprint)
                if (inserted === 'exists') {
                    const saved = await existing(requestId, fingerprint)
                    if (!saved) throw new DesktopCompanyProfileError('conflict', 'Company profile admission was not confirmed.')
                    return saved
                }
                return await execute(attempt, collect, signal)
            } finally {
                controllers.delete(requestId)
                flights.delete(requestId)
                identityFlights.delete(identityKey)
                parent?.removeEventListener('abort', stop)
            }
        })()
        flights.set(requestId, flight)
        identityFlights.set(identityKey, flight)
        return flight
    }

    async function execute(attempt: DesktopCompanyProfileAttempt, collect: boolean, signal: AbortSignal): Promise<DesktopCompanyProfileAttempt> {
        try {
            signal.throwIfAborted()
            if (attempt.kind === 'decide') return await decide(attempt, signal)
            return await enrich(attempt, collect, signal)
        } catch (error) {
            if (signal.aborted) return settle(attempt, cancelledOutcome(), attempt.evidence, attempt.modelCalled)
            if (error instanceof DesktopCompanyProfileError && error.code === 'stale') {
                return settle(attempt, staleOutcome(attempt.kind), attempt.evidence, attempt.modelCalled)
            }
            if (error instanceof DesktopCompanyProfileError && ['storage', 'closed', 'conflict', 'not_found'].includes(error.code)) throw error
            return settle(attempt, { status: 'error', reason: 'authority', message: 'Company profile authority could not confirm this request.', decision: null, profile: null }, attempt.evidence, attempt.modelCalled)
        }
    }

    async function decide(attempt: DesktopCompanyProfileAttempt, signal: AbortSignal): Promise<DesktopCompanyProfileAttempt> {
        const context = await ports.canonical.require(attempt.identity, 'decide')
        const explicit = context.session.draft.industry ?? context.accepted?.industry
        if (explicit) {
            const decision: DesktopCompanyIndustryDecision = { industry: explicit, confidence: 1, source: context.session.draft.industry ? 'manual' : 'accepted' }
            return settle(attempt, { status: 'succeeded', decision, profile: null }, [], false)
        }
        const input = desktopCompanyProfileInput(context.session, 'decide', context.accepted)
        if (!input) return settle(attempt, unavailableOutcome('invalid_input', 'decide', null), [], false)
        const selection = await ports.models.decision(attempt.identity.chat)
        if (!selection) return settle(attempt, unavailableOutcome('missing_configuration', 'decide', null), [], false)
        attempt = await progress(attempt, 'analyzing_evidence', [], true)
        signal.throwIfAborted()
        const outcome = await ports.engine.decide({ requestId: attempt.requestId, identity: attempt.identity, input, model: selection }, signal)
        await ports.canonical.require(attempt.identity, 'decide')
        signal.throwIfAborted()
        return settleEngineOutcome(attempt, outcome, null, [], null)
    }

    async function enrich(attempt: DesktopCompanyProfileAttempt, collect: boolean, signal: AbortSignal): Promise<DesktopCompanyProfileAttempt> {
        let context = await ports.canonical.require(attempt.identity, 'enrich')
        let evidence = context.discovery ? companyProfileEvidenceFromDiscovery(context.discovery) : []
        let sources: DesktopCompanyProfileSourceProgress[] = []
        if (collect) {
            const url = desktopCompanyProfileInput(context.session, 'enrich', context.accepted)
            if (!url) return settle(attempt, unavailableOutcome('invalid_input', 'enrich', null), [], false)
            attempt = await progress(attempt, 'reading_site', sources, false)
            let queue = Promise.resolve()
            const collected = await ports.collector({
                url,
                signal,
                assertCurrent: async () => { await ports.canonical.require(attempt.identity, 'enrich') },
                onEvent: event => {
                    sources = progressSources(sources, event)
                    attempt = { ...attempt, progress: { stage: 'reading_site', sources, updatedAt: now() }, updatedAt: now() }
                    const saved = attempt
                    queue = queue.then(() => ports.store.updateProgress(saved)).then(() => {})
                },
            })
            await queue
            evidence = collected.evidence
            context = await ports.canonical.require(attempt.identity, 'enrich')
        }
        if (!evidence.length) return settle(attempt, unavailableOutcome('evidence_unavailable', 'enrich', null), [], attempt.modelCalled)
        const selection = await ports.models.profile(attempt.identity.chat)
        if (!selection) {
            const profile = projectDesktopCompanyProfile({ session: context.session, accepted: context.accepted, evidence, inference: null, decision: null })
            return settle(attempt, unavailableOutcome('missing_configuration', 'enrich', profile), evidence, attempt.modelCalled)
        }
        attempt = await progress(attempt, 'analyzing_evidence', sources, true)
        signal.throwIfAborted()
        const outcome = await ports.engine.enrich({ requestId: attempt.requestId, identity: attempt.identity, evidence, model: selection }, signal)
        context = await ports.canonical.require(attempt.identity, 'enrich')
        signal.throwIfAborted()
        attempt = await progress(attempt, 'projecting_profile', sources, true)
        return settleEngineOutcome(attempt, outcome, context, evidence, sources)
    }

    async function settleEngineOutcome(
        attempt: DesktopCompanyProfileAttempt,
        outcome: DesktopCompanyProfileEngineOutcome,
        context: DesktopCompanyProfileCanonicalContext | null,
        evidence: DesktopCompanyProfileEvidence[],
        sources: DesktopCompanyProfileSourceProgress[] | null,
    ): Promise<DesktopCompanyProfileAttempt> {
        if (outcome.status === 'cancelled') return settle(attempt, cancelledOutcome(), evidence, true)
        if (outcome.status === 'error') return settle(attempt, { status: 'error', reason: outcome.reason, message: errorMessage(outcome.reason), decision: null, profile: null }, evidence, true)
        if (outcome.status === 'unavailable') {
            const profile = context ? projectDesktopCompanyProfile({ session: context.session, accepted: context.accepted, evidence, inference: null, decision: null }) : null
            return settle(attempt, unavailableOutcome(outcome.reason, attempt.kind, profile), evidence, true)
        }
        if (attempt.kind === 'decide') return settle(attempt, { status: 'succeeded', decision: outcome.decision, profile: null }, [], true)
        const inference = outcome.inference
        const profile = context ? projectDesktopCompanyProfile({ session: context.session, accepted: context.accepted, evidence, inference, decision: null }) : null
        const decision = inference?.industry ? { industry: inference.industry.industry, confidence: inference.industry.confidence, source: 'inference' as const } : null
        return settle(attempt, { status: 'succeeded', decision, profile }, evidence, true, sources ?? undefined)
    }

    async function progress(
        attempt: DesktopCompanyProfileAttempt,
        stage: DesktopCompanyProfileProgress['stage'],
        sources: DesktopCompanyProfileSourceProgress[],
        modelCalled: boolean,
    ): Promise<DesktopCompanyProfileAttempt> {
        const next = { ...attempt, modelCalled: attempt.modelCalled || modelCalled, progress: { stage, sources, updatedAt: now() }, updatedAt: now() }
        await ports.store.updateProgress(next)
        return next
    }

    async function settle(
        attempt: DesktopCompanyProfileAttempt,
        outcome: DesktopCompanyProfileOutcome,
        evidence: DesktopCompanyProfileEvidence[],
        modelCalled: boolean,
        sources?: DesktopCompanyProfileSourceProgress[],
    ): Promise<DesktopCompanyProfileAttempt> {
        if (closed || controllers.get(attempt.requestId)?.signal.aborted) outcome = cancelledOutcome()
        const settled = desktopCompanyProfileAttemptSchema.parse({
            ...attempt,
            status: outcome.status,
            outcome,
            evidence,
            modelCalled: attempt.modelCalled || modelCalled,
            progress: { stage: 'settled', sources: sources ?? attempt.progress.sources, updatedAt: now() },
            updatedAt: now(),
        })
        if (await ports.store.settle(settled)) return settled
        const current = await ports.store.get(attempt.requestId)
        if (!current) throw new DesktopCompanyProfileError('storage', 'The company profile result disappeared before confirmation.')
        return current.attempt
    }

    async function read(chat: DesktopForemanChatRef): Promise<DesktopCompanyProfileView> {
        assertOpen()
        const context = await ports.canonical.read(chat)
        const identities = desktopCompanyProfileIdentities(context.session, context.accepted)
        const [savedDecision, savedEnrichment, actorName] = await Promise.all([
            ports.store.latest(chat, 'decide'),
            ports.store.latest(chat, 'enrich'),
            readActor(chat, context),
        ])
        const decision = savedDecision && identities.decision && sameIdentity(savedDecision.identity, identities.decision) ? savedDecision : null
        const enrichment = savedEnrichment && identities.enrichment && sameIdentity(savedEnrichment.identity, identities.enrichment) ? savedEnrichment : null
        const decisionResult = decision?.status === 'succeeded' && decision.outcome?.status === 'succeeded' ? decision.outcome.decision : null
        const enrichedProfile = enrichment?.status === 'succeeded' && enrichment.outcome?.status === 'succeeded' ? enrichment.outcome.profile : null
        const profile = enrichedProfile ?? projectDesktopCompanyProfile({
            session: context.session,
            accepted: context.accepted,
            evidence: context.discovery ? companyProfileEvidenceFromDiscovery(context.discovery) : [],
            inference: null,
            decision: decisionResult,
            knownFirstName: actorName,
        })
        const knownFirstName: DesktopCompanyProfileKnownName = actorName || context.session.knownFirstName
            ? { status: 'known', firstName: actorName ?? context.session.knownFirstName!, source: 'local_profile' }
            : { status: 'unavailable', question: INTAKE_COPY.name.title }
        return desktopCompanyProfileViewSchema.parse({
            decisionIdentity: identities.decision,
            enrichmentIdentity: identities.enrichment,
            decision,
            enrichment,
            profile,
            knownFirstName,
        })
    }

    async function readActor(chat: DesktopForemanChatRef, context: DesktopCompanyProfileCanonicalContext): Promise<string | null> {
        if (context.session.knownFirstName) return context.session.knownFirstName
        try { return await ports.actor.readKnownFirstName(chat) } catch { return null }
    }

    async function cancel(raw: unknown): Promise<DesktopCompanyProfileAttempt> {
        assertOpen()
        const input = desktopCompanyProfileCancelInputSchema.parse(raw)
        const row = await ports.store.get(input.requestId)
        if (!row) throw new DesktopCompanyProfileError('not_found', 'Company profile request not found.')
        if (row.attempt.identity.chat.workspaceId !== input.chat.workspaceId || row.attempt.identity.chat.chatId !== input.chat.chatId) {
            throw new DesktopCompanyProfileError('conflict', 'This company profile request belongs to another chat.')
        }
        if (row.attempt.status === 'cancelled') return row.attempt
        if (row.attempt.status !== 'pending') return row.attempt
        controllers.get(input.requestId)?.abort()
        const cancelled = await settle(row.attempt, cancelledOutcome(), row.attempt.evidence, row.attempt.modelCalled)
        const current = await ports.store.get(input.requestId)
        return current?.attempt ?? cancelled
    }

    return {
        read,
        decide(raw: unknown, access?: { signal?: AbortSignal }) {
            const input = desktopCompanyProfileDecideInputSchema.parse(raw)
            return run('decide', input.identity, false, access?.signal, () => input.requestId)
        },
        enrich(raw: unknown, access?: { signal?: AbortSignal }) {
            const input = desktopCompanyProfileEnrichInputSchema.parse(raw)
            return run('enrich', input.identity, input.collect, access?.signal, () => input.requestId)
        },
        cancel,
        async decideIndustry(chat: DesktopForemanChatRef): Promise<TemplateCategory | null> {
            const context = await ports.canonical.read(chat)
            const identity = desktopCompanyProfileIdentities(context.session, context.accepted).decision
            if (!identity) return null
            const attempt = await run('decide', identity, false, undefined, () => desktopCompanyProfileRequestId('decide', identity))
            return attempt.outcome?.status === 'succeeded' ? attempt.outcome.decision?.industry ?? null : null
        },
        async analyzeSite(chat: DesktopForemanChatRef): Promise<{ started: boolean; attempt: DesktopCompanyProfileAttempt | null }> {
            const context = await ports.canonical.read(chat)
            const identity = desktopCompanyProfileIdentities(context.session, context.accepted).enrichment
            if (!identity) return { started: false, attempt: null }
            const attempt = await run('enrich', identity, true, undefined, () => desktopCompanyProfileRequestId('enrich', identity))
            return { started: true, attempt }
        },
        async resolveKnownFirstName(chat: DesktopForemanChatRef): Promise<string | null> {
            const context = await ports.canonical.read(chat)
            return readActor(chat, context)
        },
        async cancelChat(chat: DesktopForemanChatRef): Promise<DesktopCompanyProfileAttempt[]> {
            const pending = await ports.store.pending()
            const owned = pending.filter(attempt => attempt.identity.chat.workspaceId === chat.workspaceId && attempt.identity.chat.chatId === chat.chatId)
            const settled: DesktopCompanyProfileAttempt[] = []
            for (const attempt of owned) settled.push(await cancel({ requestId: attempt.requestId, chat }))
            return settled
        },
        async reconcile(): Promise<void> {
            for (const attempt of await ports.store.pending()) {
                if (flights.has(attempt.requestId)) continue
                await settle(attempt, { status: 'error', reason: 'interrupted', message: 'Company profile inference stopped when the app restarted. It was not restarted automatically.', decision: null, profile: null }, attempt.evidence, attempt.modelCalled)
            }
        },
        async close(): Promise<void> {
            if (closing) return closing
            closed = true
            closing = Promise.all([...flights.values()].map(flight => flight.catch(() => {}))).then(() => {})
            for (const controller of controllers.values()) controller.abort()
            return closing
        },
    }
}

function sameIdentity(a: DesktopCompanyProfileIdentity, b: DesktopCompanyProfileIdentity): boolean {
    return a.chat.workspaceId === b.chat.workspaceId && a.chat.chatId === b.chat.chatId
        && a.draftRevision === b.draftRevision && a.inputDigest === b.inputDigest
}

function progressSources(current: DesktopCompanyProfileSourceProgress[], event: DesktopCompanyProfileCollectorEvent): DesktopCompanyProfileSourceProgress[] {
    const next = current.filter(row => row.source !== event.source)
    if (event.type === 'pending') next.push({ source: event.source, state: 'pending', reason: null })
    if (event.type === 'unavailable') next.push({ source: event.source, state: 'unavailable', reason: event.reason })
    if (event.type === 'settled') next.push({ source: event.source, state: event.status === 'found' ? 'found' : 'unavailable', reason: event.reason })
    return next
}

function correction(kind: 'decide' | 'enrich'): DesktopCompanyProfileCorrection {
    return kind === 'decide'
        ? { field: 'industry', prompt: INTAKE_COPY.industry.title, preserveOriginalQuestion: true }
        : { field: 'companyUrl', prompt: INTAKE_COPY.company.title, preserveOriginalQuestion: true }
}

function staleOutcome(kind: 'decide' | 'enrich'): DesktopCompanyProfileOutcome {
    return { status: 'stale', message: 'These company details changed. Review the current question before trying again.', correction: correction(kind), decision: null, profile: null }
}

function cancelledOutcome(): DesktopCompanyProfileOutcome {
    return { status: 'cancelled', message: 'Company profile inference was stopped. No late result was published.', decision: null, profile: null }
}

function unavailableOutcome(
    reason: Extract<DesktopCompanyProfileOutcome, { status: 'unavailable' }>['reason'],
    kind: 'decide' | 'enrich',
    profile: DesktopCompanyProfileProjection | null,
): DesktopCompanyProfileOutcome {
    const messages = {
        missing_configuration: 'Company inference is not configured for this purpose. No other model or credential was used.',
        low_confidence: 'The configured model could not determine this confidently. Answer the original question instead.',
        invalid_input: 'The current company input cannot be used. Review the original question.',
        evidence_unavailable: 'The confined readers did not provide enough sourced company evidence.',
        model_unavailable: 'The configured model is unavailable. No fallback model was called.',
        timeout: 'Company inference exceeded its deadline. No fallback model was called.',
    } as const
    return { status: 'unavailable', reason, message: messages[reason], correction: correction(kind), decision: null, profile }
}

function errorMessage(reason: Extract<DesktopCompanyProfileOutcome, { status: 'error' }>['reason']): string {
    switch (reason) {
        case 'invalid_model_response': return 'The configured model returned an invalid company profile. Nothing was inferred.'
        case 'interrupted': return 'Company profile inference stopped when the app restarted. It was not restarted automatically.'
        case 'storage': return 'Company profile storage could not confirm the result.'
        case 'authority': return 'Company profile authority could not confirm this request.'
        default: return 'The configured model failed. No other model was called.'
    }
}
