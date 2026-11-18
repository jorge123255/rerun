import { expect, test, vi } from 'vitest'
import { desktopRerunToolCatalog } from '@rerun/contracts'

const saved = vi.hoisted(() => ({ config: null as any }))
vi.mock('../../agents/loader.js', () => ({ readAgentConfig: async () => saved.config }))
const { desktopWorkRegisterTools } = await import('./tools.js')
const { DesktopWorkRegisterRefusal } = await import('./delivery.js')
const { desktopToolInstruction, hasDesktopToolGrant } = await import('../tool-grants.js')

function context(grant: boolean | undefined, extra: Record<string, unknown> = {}) {
    const config = { name: 'Ada', enabled: true, kind: 'agent', selfImprovement: { enabled: false }, tools: { desktopToolGrants: grant === undefined ? {} : { workRegister: grant } }, ...extra }
    saved.config = config
    return { agent: { id: 'ada', config }, sessionId: 's1', runId: 'r1', abortSignal: new AbortController().signal } as any
}
const call = (tools: any, name: string, input: unknown) => tools[name].execute(input, { toolCallId: 'c1', abortSignal: new AbortController().signal })

test('the Work register permission is a row of its own, off unless it is switched on', () => {
    const row = desktopRerunToolCatalog.find(entry => entry.id === 'workRegister')
    expect(row).toMatchObject({ label: 'Work register', available: true, tools: ['work_list', 'work_upsert', 'work_note'] })
    const deliver = vi.fn()
    // Never set, and set off: no tools, nothing delivered, and the coworker is not told about them.
    for (const grant of [undefined, false]) {
        const ctx = context(grant)
        expect(desktopWorkRegisterTools(ctx, { deliver })).toEqual({})
        expect(hasDesktopToolGrant(ctx.agent.config, 'workRegister')).toBe(false)
        expect(desktopToolInstruction(ctx.agent.config)).not.toContain('work_list')
    }
    expect(deliver).not.toHaveBeenCalled()
})

test('a copy of a coworker never gets the register, even with the permission', () => {
    expect(desktopWorkRegisterTools(context(true, { ephemeral: true }), { deliver: vi.fn() })).toEqual({})
})

test('each call sends the run\'s own identity and returns the app\'s answer', async () => {
    const deliver = vi.fn(async () => ({ counts: { working: 1 }, items: [] }))
    const ctx = context(true)
    const tools = desktopWorkRegisterTools(ctx, { deliver })
    expect(Object.keys(tools)).toEqual(['work_list', 'work_upsert', 'work_note'])
    expect(desktopToolInstruction(ctx.agent.config)).toContain('The work register (work_list, work_upsert, work_note)')
    expect(JSON.parse(await call(tools, 'work_list', { status: 'open' }))).toEqual({ counts: { working: 1 }, items: [] })
    expect(deliver).toHaveBeenCalledWith({ op: 'list', caller: { agentId: 'ada', sessionId: 's1', runId: 'r1' }, input: { status: 'open' } }, expect.any(AbortSignal))
})

test('the permission switched off during a run refuses the next call before anything is sent', async () => {
    const deliver = vi.fn()
    const ctx = context(true)
    const tools = desktopWorkRegisterTools(ctx, { deliver })
    saved.config = { ...ctx.agent.config, tools: { desktopToolGrants: { workRegister: false } } }
    expect(JSON.parse(await call(tools, 'work_upsert', { project: 'p', objective: 'o' }))).toEqual({ error: 'This tool is turned off for this coworker.' })
    expect(deliver).not.toHaveBeenCalled()
})

test('the app\'s refusal reaches the model as it was said; an unknown outcome is never called a success', async () => {
    const deliver = vi.fn()
        .mockRejectedValueOnce(new DesktopWorkRegisterRefusal('This item belongs to another coworker.', 403))
        .mockRejectedValueOnce(new Error('socket hang up'))
    const tools = desktopWorkRegisterTools(context(true), { deliver })
    expect(JSON.parse(await call(tools, 'work_note', { id: 'w_1', update: 'x' }))).toEqual({ error: 'This item belongs to another coworker.' })
    expect(JSON.parse(await call(tools, 'work_note', { id: 'w_1', update: 'x' })).error).toContain('did not confirm')
    expect(deliver).toHaveBeenCalledTimes(2)
})
