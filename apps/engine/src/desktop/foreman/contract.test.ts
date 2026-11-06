import { foremanBuildActionSchema, foremanDecisionInputSchema, foremanRevisionSchema, foremanShowPlanInputSchema } from '@rerun/contracts'
import { expect, test } from 'vitest'

// Kept here, outside packages/contracts/src, so production contract compilation never sees it.
const agent = (name: string, box?: string) => ({ kind: 'agent', name, role: `Does ${name}`, ...(box ? { box } : {}) })

test('show_plan refuses duplicate Boxes, duplicate names, unknown Boxes and oversize cards', () => {
    expect(foremanShowPlanInputSchema.safeParse({ title: 'T', boxes: [{ name: 'Sales' }, { name: 'sales' }], items: [agent('A')] }).success).toBe(false)
    expect(foremanShowPlanInputSchema.safeParse({ title: 'T', items: [agent('A'), agent('a')] }).success).toBe(false)
    expect(foremanShowPlanInputSchema.safeParse({ title: 'T', boxes: [{ name: 'Sales' }], items: [agent('A', 'Ops')] }).success).toBe(false)
    expect(foremanShowPlanInputSchema.safeParse({ title: 'T', items: Array.from({ length: 9 }, (_, index) => agent(`A${index}`)) }).success).toBe(false)
    expect(foremanShowPlanInputSchema.safeParse({ title: 'T', items: [{ ...agent('A'), approved: true }] }).success).toBe(false)
})

test('decisions need a request id, exact revision and digest; there is no model origin field', () => {
    const base = { decision: 'confirm', requestId: crypto.randomUUID(), chat: { workspaceId: 'ws', chatId: 'fmc_chat-0001' }, planId: 'fmp_plan-0001', revisionId: 'fmr_rev-00001', digest: 'a'.repeat(64) }
    expect(foremanDecisionInputSchema.safeParse(base).success).toBe(true)
    expect(foremanDecisionInputSchema.safeParse({ ...base, origin: 'model' }).success).toBe(false)
    expect(foremanDecisionInputSchema.safeParse({ ...base, digest: undefined }).success).toBe(false)
    expect(foremanDecisionInputSchema.safeParse({ ...base, decision: 'ask_changes' }).success).toBe(false)
})

test('renderer DTOs refuse host paths and credentials smuggled as extra fields', () => {
    expect(foremanBuildActionSchema.safeParse({ action: 'stop', requestId: crypto.randomUUID(), chat: { workspaceId: 'ws', chatId: 'fmc_chat-0001' }, buildId: 'fmb_build-001', apiKey: 'sk' }).success).toBe(false)
    expect(foremanRevisionSchema.shape.model.safeParse({ connectionId: 'c', model: 'm', apiKey: 'sk' }).success).toBe(false)
})
