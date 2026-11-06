import type { TemplateCategory } from '@rerun/contracts'
import type { DesktopShownPlanView } from '@/lib/desktop/foreman-client'
import { intakePreviewPlan } from '@/lib/onboarding/intake'

export type DesktopCompanyProfilePreviewScope = {
    workspaceId: string
    chatId: string
    active: boolean
    emptyWorkspace: boolean
    onboarding: boolean
}

export type DesktopCompanyProfilePreview = {
    scopeKey: string
    plan: DesktopShownPlanView
}

export function companyProfilePreviewPlan(scope: DesktopCompanyProfilePreviewScope, input: {
    industry: TemplateCategory | null
    companyName?: string | null
}): DesktopCompanyProfilePreview | null {
    if (!scope.active || !scope.emptyWorkspace || !scope.onboarding || !input.industry) return null
    return {
        scopeKey: `${scope.workspaceId}:${scope.chatId}`,
        plan: intakePreviewPlan(input.industry, input.companyName),
    }
}

export type DesktopCompanyProfileRequestIdentity = {
    workspaceId: string
    chatId: string
    requestId: string
    draftRevision: number
    input: string
}

export function isCurrentCompanyProfileRequest(candidate: DesktopCompanyProfileRequestIdentity, current: DesktopCompanyProfileRequestIdentity): boolean {
    return candidate.workspaceId === current.workspaceId
        && candidate.chatId === current.chatId
        && candidate.requestId === current.requestId
        && candidate.draftRevision === current.draftRevision
        && candidate.input === current.input
}
