import type { DesktopAgentCapturePlan, DesktopCaptureSelection, DesktopTemplateSetup } from './types'

export function defaultDesktopExcludedPaths(plan: DesktopAgentCapturePlan): string[] {
    return plan.files.filter(file => file.defaultExcluded).map(file => file.path)
}

export function toggleDesktopExcludedPaths(plan: DesktopAgentCapturePlan, current: string[], paths: string[], keep: boolean): string[] {
    const allowed = new Set(plan.files.map(file => file.path))
    const touched = new Set(paths.filter(path => allowed.has(path)))
    if (keep) return current.filter(path => !touched.has(path))
    return [...new Set([...current.filter(path => allowed.has(path)), ...touched])]
}

export function buildDesktopCaptureSelections(
    plans: DesktopAgentCapturePlan[],
    excluded: Record<string, string[]>,
    setups: Record<string, DesktopTemplateSetup>,
): DesktopCaptureSelection[] {
    return plans.map(plan => {
        const allowed = new Set(plan.files.map(file => file.path))
        const setup = setups[plan.agentRowId]
        return {
            agentRowId: plan.agentRowId,
            exclude: (excluded[plan.agentRowId] ?? []).filter(path => allowed.has(path)),
            ...(setup?.required === null || setup === undefined ? {} : { setup: { required: setup.required, prompt: setup.prompt } }),
        }
    })
}
