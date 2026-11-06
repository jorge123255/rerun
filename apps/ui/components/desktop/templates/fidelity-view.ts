import type { DesktopTemplateDetail as DetailContract, DesktopTemplatePlan } from '@rerun/contracts'
import type { DesktopAgentCapturePlan, DesktopTemplateDetail } from './types'
export function templateFidelityView(detail: DetailContract): Pick<DesktopTemplateDetail, 'fidelityCoworkers'> {
    return { fidelityCoworkers: detail.coworkers.map(c => ({ name:c.name, agentKey:c.agentKey, files:c.files, requirements:c.requirements ?? [], envKeys:c.envKeys, mcpAuth:c.mcpAuth })) }
}
export function captureFidelityView(plan: DesktopTemplatePlan, current: DesktopAgentCapturePlan[]): DesktopAgentCapturePlan[] {
    return current.map(c => ({ ...c, requirements:plan.coworkers.find(p => p.agentId === c.agentRowId)?.requirements ?? [] }))
}
