import type { CompanyBriefModelRef } from '@rerun/contracts'
import { openDesktopCompanyBriefModel } from '../company-brief/model.js'

export type CompanyProfileInferenceAdapter = {
    confirm(selection: CompanyBriefModelRef): Promise<boolean>
    complete(input: { selection: CompanyBriefModelRef; prompt: string; signal: AbortSignal }): Promise<string | null>
}

export function openDesktopCompanyProfileInferenceAdapter(): CompanyProfileInferenceAdapter {
    return openDesktopCompanyBriefModel()
}
