import type { AgentArchiveEntry, TemplateAgent, TemplateCategory } from '@rerun/contracts'

export type DesktopTemplateIdentity = {
    templateId: string
    revision: string
}

export type DesktopTemplateDraft = DesktopTemplateIdentity

export type DesktopTemplateSetup = {
    required: boolean | null
    prompt: string
}

export type DesktopCaptureSourceAgent = {
    id: string
    name: string
    handle: string
    description: string
}

export type DesktopCaptureWorkspace = {
    id: string
    name: string | null
    agents: DesktopCaptureSourceAgent[]
}

export type DesktopCaptureIssue = {
    path: string
    reason: string
}

export type DesktopAgentCapturePlan = {
    agentRowId: string
    name: string
    displayName: string
    description: string
    sourceRevision: string
    files: AgentArchiveEntry[]
    skills: { slug: string; name: string; description: string }[]
    setup: DesktopTemplateSetup
    exclusions: DesktopCaptureIssue[]
    unsupportedEntries: DesktopCaptureIssue[]
}

export type DesktopCapturePlanSet = {
    planId: string
    revision: string
    plans: DesktopAgentCapturePlan[]
}

export type DesktopCaptureSelection = {
    agentRowId: string
    exclude: string[]
    setup?: { required: boolean; prompt: string }
}

export type DesktopTemplateSummary = DesktopTemplateIdentity & {
    title: string
    tagline: string
    category: TemplateCategory
    updatedAt: string
    agents: TemplateAgent[]
}

export type DesktopTemplateDetail = DesktopTemplateSummary & {
    description: string
    capturedAt: string | null
    exclusions: DesktopCaptureIssue[]
    unsupportedEntries: DesktopCaptureIssue[]
}

export type DesktopInstalledCoworker = {
    id: string
    name: string
}

export type DesktopTemplateInstallReceipt = {
    receiptId: string
    coworkers: DesktopInstalledCoworker[]
}

export type DesktopTemplateInstallIntent = DesktopTemplateIdentity & {
    requestId: string
}
