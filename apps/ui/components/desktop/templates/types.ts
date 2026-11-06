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
    requirements?: import('@rerun/contracts').DesktopTemplateRequirement[]
    agentRowId: string
    name: string
    displayName: string
    description: string
    sourceRevision: string
    included?: { path: string; text: string }[]
    blocked?: string | null
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
    draftRevision?: string
    title: string
    tagline: string
    category: TemplateCategory
    updatedAt: string
    agents: TemplateAgent[]
}

export type DesktopTemplateDetail = DesktopTemplateSummary & {
    fidelityCoworkers?: (Pick<import('@rerun/contracts').DesktopTemplateDetail['coworkers'][number], 'agentKey'|'name'|'files'|'envKeys'|'mcpAuth'> & { requirements: import('@rerun/contracts').DesktopTemplateRequirement[] })[]
    description: string
    capturedAt: string | null
    exclusions: DesktopCaptureIssue[]
    unsupportedEntries: DesktopCaptureIssue[]
    portable?: {
        binaryAssets: boolean
        userSkillTrees: boolean
        sourceKind: 'local-v1' | 'portable-capture' | 'portable-import' | 'local-v1-export'
        notes: string[]
    }
    provenance?: {
        importedAt: string
        sourcePackageKey: string
        sourceContentDigest: string
        sourceTitle: string
    }
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

export type DesktopTemplateLibraryChange = { operation:'export'|'import'|'delete'; templateId:string }
