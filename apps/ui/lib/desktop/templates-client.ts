'use client'

import { desktopTemplateCaptureResultSchema, desktopTemplateCreateDraftResultSchema, desktopTemplateDetailSchema, desktopTemplateInstallResultSchema, desktopTemplateListSchema, desktopTemplateOperationSchema, desktopTemplatePlanSchema, desktopTemplateReceiptSchema, desktopTemplateSourcesResultSchema, templateAgentSchema, type DesktopTemplatePlan } from '@rerun/contracts'
import type { DesktopCapturePlanSet, DesktopCaptureSelection, DesktopCaptureWorkspace, DesktopTemplateDetail, DesktopTemplateDraft, DesktopTemplateIdentity, DesktopTemplateInstallIntent, DesktopTemplateInstallReceipt, DesktopTemplateSummary } from '@/components/desktop/templates/types'
import { desktopTemplateInstallStateSchema, type DesktopTemplateInstallState } from './template-install-state'

const UNKNOWN = 'Local template acknowledgement is unknown. Retry the same attempt.'
export class DesktopTemplateRequestError extends Error {
    constructor(message: string, readonly definite: boolean) { super(message); this.name = 'DesktopTemplateRequestError' }
}

export function createDesktopTemplatesClient() {
    const base = '/api/desktop/templates'
    const controllers = new Set<AbortController>()
    const againRequests = new Map<string,string>()
    const plans = new Map<string, DesktopTemplatePlan>()
    const installs = new Map<string, DesktopTemplateInstallIntent>()
    const installGenerations = new Map<string, number>()
    let closed = false
    async function fetchResponse(url: string, init: RequestInit): Promise<unknown> {
        if (closed) throw new DesktopTemplateRequestError('Template panel was closed. Reopen it to reconcile the attempt.', false)
        const controller = new AbortController()
        controllers.add(controller)
        try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)])
            const response = await fetch(url, { ...init, cache: 'no-store', signal })
            const data = await response.json()
            signal.throwIfAborted()
            if (closed) throw new Error('Panel closed')
            if (!response.ok) throw new DesktopTemplateRequestError(typeof data.error === 'string' ? data.error : 'Template request refused', [400, 404, 409, 413].includes(response.status))
            return data
        } catch (error) {
            if (error instanceof DesktopTemplateRequestError) throw error
            throw new DesktopTemplateRequestError(UNKNOWN, false)
        } finally { controllers.delete(controller) }
    }
    function request(body: Record<string, unknown>, intent = false) {
        return fetchResponse(`${base}${intent ? '/intent' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    }
    async function mutate(body: Record<string, unknown>, againRequestId?: string, expectedRequestId?: string) {
        const operation = desktopTemplateOperationSchema.parse(await request({ operation: body, ...(againRequestId ? { againRequestId } : {}) }, true))
        if (expectedRequestId && (!('requestId' in operation) || operation.requestId !== expectedRequestId)) throw new DesktopTemplateRequestError('This installation changed. Reopen the template to review its current status.', true)
        if (operation.operation === 'install') installs.set(`${operation.templateId}:${operation.revision}`, { templateId: operation.templateId, revision: operation.revision, requestId: operation.requestId })
        return request(operation)
    }
    function detailOf(raw: unknown): DesktopTemplateDetail {
        const detail = desktopTemplateDetailSchema.parse(raw)
        return {
            templateId: detail.templateId, revision: detail.revision, title: detail.title, tagline: '', category: 'other', updatedAt: detail.capturedAt,
            description: detail.proseWarning, capturedAt: detail.capturedAt,
            agents: detail.coworkers.map(coworker => templateAgentSchema.parse({ key: coworker.agentKey, name: coworker.name, description: coworker.description, setupRequired: coworker.setup.required,
                skills: [...new Set(coworker.files.filter(file => file.kind === 'skill').map(file => file.path.split('/')[1]))].map(name => ({ name })) })),
            exclusions: detail.coworkers.flatMap(coworker => coworker.exclusions), unsupportedEntries: [],
        }
    }
    return {
        async createDraft(title: string): Promise<DesktopTemplateDraft> {
            return desktopTemplateCreateDraftResultSchema.parse(await mutate({ operation: 'create-draft', title: title.trim() }))
        },
        async sources(): Promise<DesktopCaptureWorkspace[]> {
            return desktopTemplateSourcesResultSchema.parse(await request({ operation: 'sources' })).spaces.map(space => ({ id: space.id ?? 'unplaced', name: space.name ?? 'Outside Boxes', agents: space.agents.map(agent => ({ ...agent, handle: agent.name })) }))
        },
        async plan(draft: DesktopTemplateDraft, input: { workspaceId: string; agentIds: string[] }): Promise<DesktopCapturePlanSet> {
            const result = desktopTemplatePlanSchema.parse(await mutate({ operation: 'plan', templateId: draft.templateId, revision: draft.revision, agentIds: [...input.agentIds].sort() }))
            plans.set(result.planRevision, result)
            return { planId: result.planRevision, revision: result.planRevision, plans: result.coworkers.map(coworker => ({
                agentRowId: coworker.agentId, name: coworker.name, displayName: coworker.name, description: coworker.description, sourceRevision: coworker.sourceRevision,
                included: coworker.included, blocked: coworker.blocked,
                files: [...coworker.selectableFiles, ...coworker.selectableSkills.flatMap(skill => skill.files)].map(file => ({ ...file, defaultExcluded: false, note: '' })),
                skills: coworker.selectableSkills, setup: coworker.setup, exclusions: coworker.exclusions, unsupportedEntries: [],
            })) }
        },
        async capture(draft: DesktopTemplateDraft, plan: DesktopCapturePlanSet, selections: DesktopCaptureSelection[]) {
            const canonical = plans.get(plan.planId)
            if (!canonical) throw new DesktopTemplateRequestError('Review the current capture plan before capturing.', true)
            const selected = selections.map(selection => {
                const coworker = canonical.coworkers.find(item => item.agentId === selection.agentRowId)
                if (!coworker) throw new DesktopTemplateRequestError('The selected coworker is not in this plan.', true)
                return { agentId: selection.agentRowId, files: coworker.selectableFiles.filter(file => !selection.exclude.includes(file.path)).map(file => file.path),
                    skills: coworker.selectableSkills.filter(skill => skill.files.every(file => !selection.exclude.includes(file.path))).map(skill => skill.slug), ...(selection.setup ? { setup: selection.setup } : {}) }
            })
            const captured = desktopTemplateCaptureResultSchema.parse(await mutate({ operation: 'capture', templateId: draft.templateId, revision: draft.revision, planRevision: canonical.planRevision, selections: selected }))
            return { revision: captured.revision, captured: selected.length, warnings: [] as string[] }
        },
        async list(): Promise<DesktopTemplateSummary[]> {
            const result = desktopTemplateListSchema.parse(await request({ operation: 'list' }))
            return Promise.all(result.templates.filter(template => template.status === 'captured' && template.revision).map(template => this.detail({ templateId: template.templateId, revision: template.revision! })))
        },
        async detail(template: DesktopTemplateIdentity): Promise<DesktopTemplateDetail> { return detailOf(await request({ operation: 'detail', templateId: template.templateId, revision: template.revision })) },
        async currentInstall(template: DesktopTemplateIdentity): Promise<DesktopTemplateInstallState> {
            const key = `${template.templateId}:${template.revision}`
            const generation = installGenerations.get(key) ?? 0
            const query = new URLSearchParams({ templateId: template.templateId, revision: template.revision })
            const result = desktopTemplateInstallStateSchema.parse(await fetchResponse(`${base}/intent?${query}`, { method: 'GET' }))
            if (result.templateId !== template.templateId || result.revision !== template.revision || generation !== (installGenerations.get(key) ?? 0)) throw new DesktopTemplateRequestError(UNKNOWN, false)
            if (result.status === 'pending') installs.set(key, { templateId: result.templateId, revision: result.revision, requestId: result.requestId })
            else { installs.delete(key); againRequests.delete(key) }
            return result
        },
        async install(template: DesktopTemplateIdentity, options: { again?: boolean; requestId?: string } = {}): Promise<DesktopTemplateInstallReceipt> {
            const key = `${template.templateId}:${template.revision}`
            installGenerations.set(key, (installGenerations.get(key) ?? 0) + 1)
            if(options.again && !againRequests.has(key))againRequests.set(key,crypto.randomUUID())
            let raw:unknown
            try {raw=await mutate({ operation: 'install', templateId: template.templateId, revision: template.revision }, againRequests.get(key), options.requestId)}
            catch(error){if(error instanceof DesktopTemplateRequestError && error.definite){againRequests.delete(key);installs.delete(key)}throw error}
            const result = desktopTemplateInstallResultSchema.parse(raw)
            if (result.status !== 'installed') throw new DesktopTemplateRequestError(result.reason, false)
            if (result.templateId !== template.templateId || result.revision !== template.revision || result.requestId !== installs.get(key)?.requestId) throw new DesktopTemplateRequestError(UNKNOWN, false)
            againRequests.delete(key)
            installs.delete(key)
            return { receiptId: result.receiptId, coworkers: result.coworkers }
        },
        pendingInstall(template: DesktopTemplateIdentity): DesktopTemplateInstallIntent | null { return installs.get(`${template.templateId}:${template.revision}`) ?? null },
        async receipt(intent: DesktopTemplateInstallIntent) { return desktopTemplateReceiptSchema.parse(await request({ operation: 'receipt', requestId: intent.requestId })) },
        dispose() { closed = true; for (const controller of controllers) controller.abort(); controllers.clear() },
    }
}
export type DesktopTemplatesClient = ReturnType<typeof createDesktopTemplatesClient>
