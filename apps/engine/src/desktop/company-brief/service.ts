import type { Client } from '@libsql/client'
import { z } from 'zod'
import {
    COMPANY_BRIEF_NO_SOURCES,
    COMPANY_BRIEF_SECTIONS,
    companyBriefAttemptSchema,
    companyBriefEvidence,
    companyBriefHandoffResultSchema,
    companyBriefResultSchema,
    type CompanyBriefAttempt,
    type CompanyBriefHandoffInput,
    type CompanyBriefHandoffResult,
    type CompanyBriefModelRef,
    type CompanyBriefResult,
    type CompanyBriefSynthesizeInput,
    type DesktopForemanDiscoveryRun,
} from '@rerun/contracts'
import { HttpError } from '../../lib/errors.js'
import type { CompanyBriefBrain } from './brain.js'
import { companyBriefProposalDraft } from './brain.js'
import { companyBriefPrompt, emptySkippedResult, groundCompanyBrief, planCompanyBriefPages } from './ground.js'
import type { CompanyBriefModel } from './model.js'
import { companyBriefSourceRevision } from './revision.js'
import { DESKTOP_COMPANY_BRIEF_SCHEMA_SQL } from './schema.js'

const modelOutputSchema = z.object({
    claims: z.array(z.object({
        section: z.enum(COMPANY_BRIEF_SECTIONS),
        text: z.string().min(1).max(600),
        sources: z.array(z.string().min(1).max(80)).min(1).max(4),
    })).max(40),
    unknowns: z.array(z.string().min(1).max(300)).max(20),
})

export type CompanyBriefSynthesizeResult = { attempt: CompanyBriefAttempt; modelCalled: boolean }
type Deps = { model: CompanyBriefModel; brain: CompanyBriefBrain; now?: () => string }
type Gate = { draft: string | null; draftRevision: number }

const STALE = 'This research changed. Review the current sources before deciding.'
const OTHER_CHAT = 'This research belongs to another chat.'
const FINISHED = 'This brief already finished.'
const STORAGE = 'Company brief storage is not initialized.'

export function createCompanyBriefService(getDatabase: () => Promise<Client>, deps: Deps) {
    let ready = false
    const controllers = new Map<string, AbortController>()
    const now = () => deps.now?.() ?? new Date().toISOString()

    async function db(): Promise<Client> {
        if (!ready) throw new HttpError(503, STORAGE)
        return getDatabase()
    }

    async function initialize(): Promise<void> {
        const client = await getDatabase()
        await client.executeMultiple(DESKTOP_COMPANY_BRIEF_SCHEMA_SQL)
        await client.execute({ sql: `UPDATE desktop_company_briefs SET status = 'stopped', error_code = 'stopped', error_message = 'Company research stopped when the app restarted.', updated_at = ? WHERE status = 'pending'`, args: [now()] })
        for (const controller of controllers.values()) controller.abort()
        ready = true
    }

    async function row(requestId: string): Promise<CompanyBriefAttempt | null> {
        const found = (await (await db()).execute({ sql: 'SELECT * FROM desktop_company_briefs WHERE request_id = ?', args: [requestId] })).rows[0]
        return found ? attemptOf(found) : null
    }

    async function read(workspaceId: string, chatId: string): Promise<CompanyBriefAttempt | null> {
        const found = (await (await db()).execute({
            sql: 'SELECT * FROM desktop_company_briefs WHERE workspace_id = ? AND chat_id = ? ORDER BY updated_at DESC, request_id DESC LIMIT 1',
            args: [workspaceId, chatId],
        })).rows[0]
        return found ? attemptOf(found) : null
    }

    async function contextBlocks(workspaceId: string, chatId: string, sourceRevision: string): Promise<boolean> {
        const found = (await (await db()).execute({
            sql: 'SELECT source_revision, active FROM desktop_company_brief_context WHERE workspace_id = ? AND chat_id = ?',
            args: [workspaceId, chatId],
        })).rows[0]
        if (!found) return false
        return Number(found.active) === 0 || String(found.source_revision) !== sourceRevision
    }

    async function observe(input: { workspaceId: string; chatId: string; sourceRevision: string; active: boolean }): Promise<void> {
        await (await db()).execute({
            sql: `INSERT INTO desktop_company_brief_context(workspace_id, chat_id, source_revision, active, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(workspace_id, chat_id) DO UPDATE SET source_revision = excluded.source_revision, active = excluded.active, updated_at = excluded.updated_at`,
            args: [input.workspaceId, input.chatId, input.sourceRevision, input.active ? 1 : 0, now()],
        })
    }

    function requireChat(attempt: CompanyBriefAttempt, workspaceId: string, chatId: string): void {
        if (attempt.workspaceId !== workspaceId || attempt.chatId !== chatId) throw new HttpError(409, OTHER_CHAT)
    }

    async function mark(requestId: string, status: CompanyBriefAttempt['status'], error: { code: string; message: string } | null, result?: CompanyBriefResult | null): Promise<boolean> {
        const client = await db()
        const stamp = now()
        const changed = await client.execute({
            sql: `UPDATE desktop_company_briefs SET status = ?, error_code = ?, error_message = ?, result_json = COALESCE(?, result_json), updated_at = ?
                WHERE request_id = ? AND status = 'pending'`,
            args: [status, error?.code ?? null, error?.message ?? null, result === undefined ? null : JSON.stringify(result), stamp, requestId],
        })
        return Number(changed.rowsAffected) > 0
    }

    async function synthesize(input: CompanyBriefSynthesizeInput, signal: AbortSignal, gate: Gate = { draft: null, draftRevision: 0 }): Promise<CompanyBriefSynthesizeResult> {
        assertSnapshot(input)
        const existing = await row(input.requestId).catch(error => {
            if (error instanceof HttpError && error.status === 503) throw error
            throw error
        })
        if (existing) {
            requireChat(existing, input.workspaceId, input.chatId)
            return { attempt: existing, modelCalled: false }
        }
        const client = await db()
        await client.execute({
            sql: `INSERT INTO desktop_company_briefs(request_id, workspace_id, chat_id, discovery_id, run_id, source_revision, model_json, snapshot_json, status, result_json, draft_text, draft_revision, error_code, error_message, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL, NULL, ?, ?)`,
            args: [input.requestId, input.workspaceId, input.chatId, input.snapshot.discoveryId, input.snapshot.runId, input.sourceRevision, JSON.stringify(input.model), JSON.stringify(input.snapshot), gate.draft, gate.draftRevision, now(), now()],
        })
        const controller = new AbortController()
        controllers.set(input.requestId, controller)
        const stop = () => controller.abort()
        signal.addEventListener('abort', stop, { once: true })
        try {
            return await finish(input, controller.signal)
        } finally {
            signal.removeEventListener('abort', stop)
            controllers.delete(input.requestId)
        }
    }

    async function finish(input: CompanyBriefSynthesizeInput, signal: AbortSignal): Promise<CompanyBriefSynthesizeResult> {
        const blocked = () => contextBlocks(input.workspaceId, input.chatId, input.sourceRevision)
        if (await blocked() || signal.aborted) {
            await mark(input.requestId, signal.aborted ? 'cancelled' : 'stale', signal.aborted ? { code: 'cancelled', message: 'Company research was stopped.' } : { code: 'stale_source', message: STALE })
            return { attempt: (await row(input.requestId))!, modelCalled: false }
        }
        if (!companyBriefEvidence(input.snapshot).length) {
            await mark(input.requestId, 'skipped', { code: 'no_sources', message: COMPANY_BRIEF_NO_SOURCES }, emptySkippedResult(input.snapshot))
            return { attempt: (await row(input.requestId))!, modelCalled: false }
        }
        if (!await deps.model.confirm(input.model)) {
            await mark(input.requestId, 'failed', { code: 'missing_model', message: 'Choose the connected model for this chat before researching the company.' })
            return { attempt: (await row(input.requestId))!, modelCalled: false }
        }
        let text: string | null
        try {
            text = await deps.model.complete({ selection: input.model, prompt: companyBriefPrompt(input.snapshot), signal })
        } catch (error) {
            if (signal.aborted || isAbort(error)) {
                await mark(input.requestId, 'cancelled', { code: 'cancelled', message: 'Company research was stopped.' })
                return { attempt: (await row(input.requestId))!, modelCalled: true }
            }
            await mark(input.requestId, 'failed', { code: 'model_failed', message: 'The selected model did not answer. No other model was called.' })
            return { attempt: (await row(input.requestId))!, modelCalled: true }
        }
        if (signal.aborted) {
            await mark(input.requestId, 'cancelled', { code: 'cancelled', message: 'Company research was stopped.' })
            return { attempt: (await row(input.requestId))!, modelCalled: true }
        }
        if (text === null || !await deps.model.confirm(input.model)) {
            await mark(input.requestId, 'failed', { code: 'model_changed', message: 'The selected model changed. No other model was called.' })
            return { attempt: (await row(input.requestId))!, modelCalled: true }
        }
        const parsed = parseModel(text)
        if (!parsed) {
            await mark(input.requestId, 'failed', { code: 'ungrounded', message: 'The model reply was not a grounded company brief.' })
            return { attempt: (await row(input.requestId))!, modelCalled: true }
        }
        const grounded = groundCompanyBrief(input.snapshot, parsed)
        if (await blocked()) {
            await mark(input.requestId, 'stale', { code: 'stale_source', message: STALE })
            return { attempt: (await row(input.requestId))!, modelCalled: true }
        }
        await mark(input.requestId, 'accepted', null, grounded)
        return { attempt: (await row(input.requestId))!, modelCalled: true }
    }

    async function cancel(requestId: string, workspaceId: string, chatId: string): Promise<CompanyBriefAttempt> {
        const attempt = await required(requestId, workspaceId, chatId)
        if (attempt.status === 'cancelled') return attempt
        if (attempt.status !== 'pending') throw new HttpError(409, FINISHED)
        controllers.get(requestId)?.abort()
        await mark(requestId, 'cancelled', { code: 'cancelled', message: 'Company research was stopped.' })
        return (await row(requestId))!
    }

    async function edit(input: { requestId: string; workspaceId: string; chatId: string; expectedDraftRevision: number; brief: string }): Promise<CompanyBriefAttempt> {
        const attempt = await required(input.requestId, input.workspaceId, input.chatId)
        if (attempt.status !== 'accepted' && attempt.status !== 'handed') throw new HttpError(409, FINISHED)
        if (await contextBlocks(attempt.workspaceId, attempt.chatId, attempt.sourceRevision)) throw new HttpError(409, STALE)
        const changed = await (await db()).execute({
            sql: `UPDATE desktop_company_briefs SET draft_text = ?, draft_revision = draft_revision + 1, updated_at = ?
                WHERE request_id = ? AND workspace_id = ? AND chat_id = ? AND draft_revision = ?`,
            args: [input.brief, now(), input.requestId, input.workspaceId, input.chatId, input.expectedDraftRevision],
        })
        if (Number(changed.rowsAffected) === 0) throw new HttpError(409, 'The company brief draft changed. Review it again.')
        return (await row(input.requestId))!
    }

    async function dismiss(requestId: string, workspaceId: string, chatId: string): Promise<CompanyBriefAttempt> {
        const attempt = await required(requestId, workspaceId, chatId)
        if (attempt.status === 'dismissed') return attempt
        if (attempt.status === 'pending') throw new HttpError(409, 'Stop this research before dismissing it.')
        if (attempt.status === 'handed') throw new HttpError(409, 'Review the Company Brain proposals before dismissing this brief.')
        await (await db()).execute({
            sql: `UPDATE desktop_company_briefs SET status = 'dismissed', updated_at = ? WHERE request_id = ? AND status = ?`,
            args: [now(), requestId, attempt.status],
        })
        return (await row(requestId))!
    }

    async function retry(input: CompanyBriefSynthesizeInput & { previousRequestId: string }, signal: AbortSignal): Promise<CompanyBriefSynthesizeResult> {
        if (input.previousRequestId === input.requestId) throw new HttpError(400, 'Retry uses a new request id.')
        const previous = await required(input.previousRequestId, input.workspaceId, input.chatId)
        if (previous.status === 'pending') throw new HttpError(409, 'Stop this research before retrying it.')
        return synthesize(input, signal, { draft: previous.draft, draftRevision: previous.draftRevision })
    }

    async function handoff(input: CompanyBriefHandoffInput): Promise<CompanyBriefHandoffResult> {
        const attempt = await required(input.requestId, input.workspaceId, input.chatId)
        if (attempt.sourceRevision !== input.sourceRevision) throw new HttpError(409, STALE)
        if (attempt.status !== 'accepted' && attempt.status !== 'handed') throw new HttpError(409, FINISHED)
        if (!attempt.result) throw new HttpError(409, FINISHED)
        if (await contextBlocks(attempt.workspaceId, attempt.chatId, attempt.sourceRevision)) throw new HttpError(409, STALE)
        const stored = await handoffRow(input.handoffRequestId)
        if (stored) return { ...stored, recovered: true }
        const snapshot = snapshotOf(input.requestId)
        const reserved = await (await db()).execute({
            sql: 'INSERT INTO desktop_company_brief_handoffs(handoff_request_id, request_id, result_json, created_at) VALUES (?, ?, ?, ?)',
            args: [input.handoffRequestId, input.requestId, JSON.stringify({ pending: true }), now()],
        }).then(() => true, () => false)
        if (!reserved) {
            const raced = await handoffRow(input.handoffRequestId)
            if (raced) return { ...raced, recovered: true }
            throw new HttpError(409, 'That handoff did not finish. Review the Company Brain proposals before trying again.')
        }
        const allowed = new Set(companyBriefEvidence(await snapshot).map(item => item.tag))
        const plan = planCompanyBriefPages({
            result: attempt.result, draft: attempt.draft, draftRevision: attempt.draftRevision,
            includeDraft: input.includeDraft, selectedClaimIds: input.selectedClaimIds, allowedTags: allowed,
        })
        if (!plan.ok) {
            await (await db()).execute({ sql: 'DELETE FROM desktop_company_brief_handoffs WHERE handoff_request_id = ? AND result_json = ?', args: [input.handoffRequestId, JSON.stringify({ pending: true })] })
            throw new HttpError(400, plan.code === 'draft_not_included' ? 'Include the edited brief or discard the edit before proposing.' : plan.code === 'nothing_selected' ? 'Select a finding before proposing it.' : 'The edited brief cites a source the snapshot does not contain.')
        }
        const outcomes: CompanyBriefHandoffResult['outcomes'] = []
        for (const page of plan.pages) {
            const expected = input.expectedPages.find(item => item.slug === page.slug)
            if (!expected) {
                await (await db()).execute({ sql: 'DELETE FROM desktop_company_brief_handoffs WHERE handoff_request_id = ? AND result_json = ?', args: [input.handoffRequestId, JSON.stringify({ pending: true })] })
                throw new HttpError(400, 'Name the current page hash before proposing.')
            }
            const current = await deps.brain.readPage(page.slug)
            if ((current?.hash ?? null) !== expected.expectedPageHash) outcomes.push({ slug: page.slug, status: 'rejected', proposalId: null, code: 'page_changed' })
            const open = outcomes.some(item => item.slug === page.slug) ? null : await deps.brain.openProposal(page.slug)
            if (open) outcomes.push({ slug: page.slug, status: 'rejected', proposalId: open.id, code: 'open_proposal' })
        }
        if (!outcomes.length) {
            for (const page of plan.pages) {
                const expected = input.expectedPages.find(item => item.slug === page.slug)!
                try {
                    const proposed = await deps.brain.propose(companyBriefProposalDraft(page, { chatId: input.chatId, baseHash: expected.expectedPageHash }))
                    outcomes.push({ slug: page.slug, status: proposed.status, proposalId: proposed.id, code: null })
                } catch (error) {
                    if (error instanceof HttpError && (error.status === 409 || error.status === 413)) {
                        outcomes.push({ slug: page.slug, status: 'rejected', proposalId: null, code: 'page_changed' })
                        break
                    }
                    throw error
                }
            }
        }
        const status = outcomes.some(item => item.status === 'rejected') ? 'rejected' : 'recorded'
        const result = companyBriefHandoffResultSchema.parse({ handoffRequestId: input.handoffRequestId, requestId: input.requestId, status, outcomes, recovered: false })
        await (await db()).execute({ sql: 'UPDATE desktop_company_brief_handoffs SET result_json = ? WHERE handoff_request_id = ?', args: [JSON.stringify(result), input.handoffRequestId] })
        if (status === 'recorded') {
            await (await db()).execute({ sql: `UPDATE desktop_company_briefs SET status = 'handed', updated_at = ? WHERE request_id = ? AND status = 'accepted'`, args: [now(), input.requestId] })
        }
        return result
    }

    async function handoffRow(id: string): Promise<CompanyBriefHandoffResult | null> {
        const found = (await (await db()).execute({ sql: 'SELECT result_json FROM desktop_company_brief_handoffs WHERE handoff_request_id = ?', args: [id] })).rows[0]
        if (!found) return null
        const parsed = companyBriefHandoffResultSchema.safeParse(JSON.parse(String(found.result_json)))
        if (!parsed.success) throw new HttpError(409, 'That handoff did not finish. Review the Company Brain proposals before trying again.')
        return parsed.data
    }

    async function snapshotOf(requestId: string): Promise<DesktopForemanDiscoveryRun> {
        const found = (await (await db()).execute({ sql: 'SELECT snapshot_json FROM desktop_company_briefs WHERE request_id = ?', args: [requestId] })).rows[0]
        if (!found) throw new HttpError(404, 'Company brief not found')
        return JSON.parse(String(found.snapshot_json)) as DesktopForemanDiscoveryRun
    }

    async function required(requestId: string, workspaceId: string, chatId: string): Promise<CompanyBriefAttempt> {
        const attempt = await row(requestId)
        if (!attempt) throw new HttpError(404, 'Company brief not found')
        requireChat(attempt, workspaceId, chatId)
        return attempt
    }

    return { initialize, read, observe, synthesize, cancel, edit, dismiss, retry, handoff }
}

export type CompanyBriefService = ReturnType<typeof createCompanyBriefService>

function assertSnapshot(input: CompanyBriefSynthesizeInput): void {
    if (input.snapshot.chat.workspaceId !== input.workspaceId || input.snapshot.chat.chatId !== input.chatId) throw new HttpError(409, OTHER_CHAT)
    if (!input.snapshot.discoveryId.startsWith('fmx_') || !input.snapshot.runId.trim()) throw new HttpError(400, 'Invalid discovery snapshot.')
    if (companyBriefSourceRevision(input.snapshot) !== input.sourceRevision) throw new HttpError(409, STALE)
    if (input.snapshot.status === 'running') throw new HttpError(409, 'Discovery is still running. A brief waits until the snapshot is settled.')
}

function parseModel(text: string): { claims: { section: typeof COMPANY_BRIEF_SECTIONS[number]; text: string; sources: string[] }[]; unknowns: string[] } | null {
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
    try {
        const parsed = modelOutputSchema.safeParse(JSON.parse(trimmed))
        return parsed.success ? parsed.data : null
    } catch {
        return null
    }
}

function attemptOf(row: Record<string, unknown>): CompanyBriefAttempt {
    const result = row.result_json == null ? null : companyBriefResultSchema.parse(JSON.parse(String(row.result_json)))
    return companyBriefAttemptSchema.parse({
        requestId: String(row.request_id),
        workspaceId: String(row.workspace_id),
        chatId: String(row.chat_id),
        discoveryId: String(row.discovery_id),
        runId: String(row.run_id),
        sourceRevision: String(row.source_revision),
        model: JSON.parse(String(row.model_json)) as CompanyBriefModelRef,
        status: String(row.status),
        result,
        draft: row.draft_text == null ? null : String(row.draft_text),
        draftRevision: Number(row.draft_revision),
        error: row.error_code == null ? null : { code: String(row.error_code), message: String(row.error_message ?? '') },
    })
}

function isAbort(error: unknown): boolean {
    return error instanceof Error && (error.name === 'AbortError' || error.message === 'Company research was stopped.')
}
