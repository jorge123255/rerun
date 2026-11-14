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

test('a starter plan has exact template revisions and no claimed engine provenance', () => {
    const template = { kind: 'template', templateId: 'a'.repeat(32), title: 'Notes', templateRevision: 'b'.repeat(64) }
    const starter = { offerId: crypto.randomUUID(), digest: 'c'.repeat(64) }
    const saved = {
        planId: 'fmp_starter-1', revisionId: 'fmr_starter-1', revision: 1, digest: 'd'.repeat(64),
        chat: { workspaceId: 'ws', chatId: 'fmc_chat-0001' }, runId: null, toolCallId: null, model: null, starter,
        plan: { title: 'T', boxes: [{ key: 'box-0', name: 'T' }], items: [{ ...template, key: 'item-0', boxKey: 'box-0' }] },
        state: 'shown', shownAt: '2026-11-11T00:00:00Z',
    }
    expect(foremanRevisionSchema.safeParse(saved).success).toBe(true)
    expect(foremanRevisionSchema.safeParse({ ...saved, runId: crypto.randomUUID() }).success).toBe(false)
    expect(foremanRevisionSchema.safeParse({ ...saved, starter: undefined }).success).toBe(false)
    expect(foremanRevisionSchema.safeParse({ ...saved, plan: { ...saved.plan, items: [{ ...saved.plan.items[0], templateRevision: undefined }] } }).success).toBe(false)
    expect(foremanShowPlanInputSchema.safeParse({ title: 'T', items: [template] }).success).toBe(false)
})
