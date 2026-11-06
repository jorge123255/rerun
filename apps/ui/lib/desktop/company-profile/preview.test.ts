import { expect, test } from 'vitest'
import { desktopPlanScene } from '@/components/desktop/foreman/plan/plan-scene'
import { intakeBoxes, intakePreviewPlan } from '@/lib/onboarding/intake'
import { companyProfilePreviewPlan, isCurrentCompanyProfileRequest } from './preview'

const scope = { workspaceId: 'workspace-a', chatId: 'fmc_company01', active: true, emptyWorkspace: true, onboarding: true }

test('uses the original industry Boxes and company title with no coworkers', () => {
    const projected = companyProfilePreviewPlan(scope, { industry: 'saas', companyName: ' Retalk ' })
    expect(projected).not.toBeNull()
    expect(projected!.scopeKey).toBe('workspace-a:fmc_company01')
    expect(projected!.plan).toEqual(intakePreviewPlan('saas', ' Retalk '))
    expect(projected!.plan.groups.map(group => group.name)).toEqual(intakeBoxes('saas'))
    expect(projected!.plan.groups.every(group => group.items.length === 0)).toBe(true)
    expect(new Set(projected!.plan.groups.map(group => group.key)).size).toBe(projected!.plan.groups.length)
})

test('original radial geometry is retained and projection does not mutate its inputs', () => {
    const input = { industry: 'ecommerce' as const, companyName: 'Shop' }
    const before = { ...input }
    const projected = companyProfilePreviewPlan(scope, input)!
    const scene = desktopPlanScene(projected.plan, { animated: false })
    expect(scene.containers.map(container => [container.col_start, container.row_start, container.col_end, container.row_end])).toEqual(
        desktopPlanScene(intakePreviewPlan('ecommerce', 'Shop'), { animated: false }).containers.map(container => [container.col_start, container.row_start, container.col_end, container.row_end]),
    )
    expect(scene.tiles).toEqual([])
    expect(input).toEqual(before)
})

test('only the active empty-workspace onboarding context draws a tentative overlay', () => {
    for (const changed of [
        { ...scope, active: false },
        { ...scope, emptyWorkspace: false },
        { ...scope, onboarding: false },
    ]) expect(companyProfilePreviewPlan(changed, { industry: 'saas', companyName: 'Retalk' })).toBeNull()
})

test('an unknown industry does not invent a company layout', () => {
    expect(companyProfilePreviewPlan(scope, { industry: null, companyName: 'Retalk' })).toBeNull()
})

test('request identity rejects a previous site, draft, request, workspace or chat', () => {
    const current = { workspaceId: 'workspace-a', chatId: 'fmc_company01', requestId: 'request-a', draftRevision: 3, input: 'https://a.example' }
    expect(isCurrentCompanyProfileRequest(current, current)).toBe(true)
    for (const changed of [
        { ...current, workspaceId: 'workspace-b' },
        { ...current, chatId: 'fmc_other001' },
        { ...current, requestId: 'request-b' },
        { ...current, draftRevision: 4 },
        { ...current, input: 'https://b.example' },
    ]) expect(isCurrentCompanyProfileRequest(changed, current)).toBe(false)
})
