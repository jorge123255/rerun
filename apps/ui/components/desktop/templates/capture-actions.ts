import { DesktopTemplateRequestError, type DesktopTemplatesClient } from '@/lib/desktop/templates-client'
import type { DesktopCapturePlanSet, DesktopCaptureSelection, DesktopCaptureWorkspace, DesktopTemplateDraft } from './types'

export type CaptureFailure = { ok: false; error: string; uncertain: boolean }
export type CaptureSourcesResult = { ok: true; workspaces: DesktopCaptureWorkspace[] } | CaptureFailure
export type CapturePlanResult = { ok: true; plan: DesktopCapturePlanSet } | CaptureFailure
export type CaptureRunResult = { ok: true; revision: string; captured: number; warnings: string[] } | CaptureFailure

export type DesktopCaptureActions = {
    listSources: () => Promise<CaptureSourcesResult>
    plan: (input: { workspaceId: string; agentIds: string[] }) => Promise<CapturePlanResult>
    capture: (input: { plan: DesktopCapturePlanSet; selections: DesktopCaptureSelection[] }) => Promise<CaptureRunResult>
}

function failure(error: unknown): CaptureFailure {
    if (error instanceof DesktopTemplateRequestError) return { ok: false, error: error.message, uncertain: !error.definite }
    return { ok: false, error: 'The local template request did not go through. Retry the same attempt.', uncertain: true }
}

export function createDesktopCaptureActions(client: DesktopTemplatesClient, draft: DesktopTemplateDraft | null, onRevision: (revision: string) => void): DesktopCaptureActions {
    return {
        listSources: async () => {
            try {
                return { ok: true, workspaces: await client.sources() }
            } catch (error) {
                return failure(error)
            }
        },
        plan: async input => {
            if (!draft) return { ok: false, error: 'Save the template title before inspecting coworkers.', uncertain: false }
            try {
                return { ok: true, plan: await client.plan(draft, input) }
            } catch (error) {
                return failure(error)
            }
        },
        capture: async ({ plan, selections }) => {
            if (!draft) return { ok: false, error: 'Save the template title before capturing coworkers.', uncertain: false }
            try {
                const result = await client.capture(draft, plan, selections)
                onRevision(result.revision)
                return { ok: true, ...result }
            } catch (error) {
                return failure(error)
            }
        },
    }
}
