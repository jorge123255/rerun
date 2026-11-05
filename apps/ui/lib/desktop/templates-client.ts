'use client'

import type {
    DesktopCapturePlanSet,
    DesktopCaptureSelection,
    DesktopCaptureWorkspace,
    DesktopTemplateDetail,
    DesktopTemplateDraft,
    DesktopTemplateIdentity,
    DesktopTemplateInstallIntent,
    DesktopTemplateInstallReceipt,
    DesktopTemplateSummary,
} from '@/components/desktop/templates/types'

const UNKNOWN_ACKNOWLEDGEMENT = 'Local template acknowledgement is unknown. Retry the same attempt.'

export class DesktopTemplateRequestError extends Error {
    constructor(message: string, readonly definite: boolean) {
        super(message)
        this.name = 'DesktopTemplateRequestError'
    }
}

type MutationBody = Record<string, unknown> & { action: string; requestId?: string }

export function createDesktopTemplatesClient() {
    const base = '/api/desktop/templates'
    const controllers = new Set<AbortController>()
    const draftRequests = new Map<string, string>()
    const planRequests = new Map<string, string>()
    const captureRequests = new Map<string, string>()
    const installRequests = new Map<string, string>()
    let closed = false

    async function request<T>(url: string, body?: MutationBody): Promise<T> {
        if (closed) throw new DesktopTemplateRequestError('Template panel was closed. Reopen it to reconcile the attempt.', false)
        const controller = new AbortController()
        controllers.add(controller)
        try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)])
            const response = await fetch(url, {
                method: body ? 'POST' : 'GET',
                cache: 'no-store',
                signal,
                headers: body ? { 'Content-Type': 'application/json' } : {},
                body: body ? JSON.stringify(body) : undefined,
            })
            const data = await response.json() as Record<string, unknown>
            signal.throwIfAborted()
            if (closed) throw new DesktopTemplateRequestError('Template panel was closed. Reopen it to reconcile the attempt.', false)
            if (!response.ok) {
                const message = typeof data.error === 'string' ? data.error : 'The local template request was refused.'
                throw new DesktopTemplateRequestError(message, data.definite === true)
            }
            return data as T
        } catch (error) {
            if (error instanceof DesktopTemplateRequestError) throw error
            throw new DesktopTemplateRequestError(UNKNOWN_ACKNOWLEDGEMENT, false)
        } finally {
            controllers.delete(controller)
        }
    }

    function identityUrl(identity: DesktopTemplateIdentity) {
        return `${base}/${encodeURIComponent(identity.templateId)}`
    }

    async function mutate<T>(requests: Map<string, string>, key: string, url: string, body: Omit<MutationBody, 'requestId'>, requestId?: string): Promise<T> {
        const id = requestId ?? requests.get(key) ?? crypto.randomUUID()
        requests.set(key, id)
        try {
            const result = await request<T>(url, { ...body, requestId: id })
            requests.delete(key)
            return result
        } catch (error) {
            if (error instanceof DesktopTemplateRequestError && error.definite) requests.delete(key)
            throw error
        }
    }

    return {
        createDraft(title: string): Promise<DesktopTemplateDraft> {
            const normalized = title.trim()
            return mutate(draftRequests, normalized, base, { action: 'create-draft', title: normalized })
        },

        async sources(): Promise<DesktopCaptureWorkspace[]> {
            const result = await request<{ workspaces: DesktopCaptureWorkspace[] }>(`${base}?view=sources`)
            return result.workspaces
        },

        plan(draft: DesktopTemplateDraft, input: { workspaceId: string; agentIds: string[] }): Promise<DesktopCapturePlanSet> {
            const agentIds = [...input.agentIds].sort()
            const key = JSON.stringify([draft.templateId, draft.revision, input.workspaceId, agentIds])
            return mutate(planRequests, key, identityUrl(draft), {
                action: 'plan',
                revision: draft.revision,
                workspaceId: input.workspaceId,
                agentIds,
            })
        },

        capture(draft: DesktopTemplateDraft, plan: DesktopCapturePlanSet, selections: DesktopCaptureSelection[]): Promise<{ revision: string; captured: number; warnings: string[] }> {
            const key = JSON.stringify([draft.templateId, draft.revision, plan.planId, plan.revision, selections])
            return mutate(captureRequests, key, identityUrl(draft), {
                action: 'capture',
                revision: draft.revision,
                planId: plan.planId,
                planRevision: plan.revision,
                selections,
            })
        },

        async list(): Promise<DesktopTemplateSummary[]> {
            const result = await request<{ templates: DesktopTemplateSummary[] }>(`${base}?view=list`)
            return result.templates
        },

        async detail(template: DesktopTemplateIdentity): Promise<DesktopTemplateDetail> {
            const query = new URLSearchParams({ view: 'detail', revision: template.revision })
            const result = await request<{ template: DesktopTemplateDetail }>(`${identityUrl(template)}?${query}`)
            return result.template
        },

        install(template: DesktopTemplateIdentity, options: { again?: boolean; requestId?: string } = {}): Promise<DesktopTemplateInstallReceipt> {
            const key = JSON.stringify([template.templateId, template.revision])
            if (options.again) installRequests.delete(key)
            return mutate(installRequests, key, identityUrl(template), { action: 'install', revision: template.revision }, options.requestId)
        },

        pendingInstall(template: DesktopTemplateIdentity): DesktopTemplateInstallIntent | null {
            const requestId = installRequests.get(JSON.stringify([template.templateId, template.revision]))
            return requestId ? { ...template, requestId } : null
        },

        receipt(intent: DesktopTemplateInstallIntent): Promise<DesktopTemplateInstallReceipt | null> {
            const query = new URLSearchParams({ view: 'receipt', revision: intent.revision, requestId: intent.requestId })
            return request<DesktopTemplateInstallReceipt | null>(`${identityUrl(intent)}?${query}`)
        },

        dispose() {
            closed = true
            for (const controller of controllers) controller.abort()
            controllers.clear()
        },
    }
}

export type DesktopTemplatesClient = ReturnType<typeof createDesktopTemplatesClient>
