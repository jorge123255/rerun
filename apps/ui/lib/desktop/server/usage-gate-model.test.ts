import { expect, test, vi } from 'vitest'
import { desktopBackupPick, desktopPlanWait, desktopUsagePark, type ConnectionSummary, type DesktopUsageParking } from '@rerun/contracts'

vi.mock('server-only', () => ({}))
vi.mock('./database', () => ({ openDesktopDatabase: async () => { throw new Error('unused') } }))
import { DesktopPlanOutHttpError, desktopPlanOutOfPreset, gateDesktopPick } from './usage-gate-model'

const NOW = new Date('2026-11-16T10:00:00.000Z'), RESET = '2026-11-16T15:00:00.000Z'
const base = { connected: true, credentialRejected: false, extraModels: [], planLimits: null }
const limits = (usedPercent: number, resetsAt: string | null) => ({ capturedAt: NOW.toISOString(), windows: [{ kind: 'session' as const, label: null, usedPercent, resetsAt }] })
const chatgpt = (usedPercent = 100, resetsAt: string | null = RESET) => ({ ...base, id: 'mac-chatgpt', name: 'ChatGPT', provider: 'codex', models: ['gpt-6-sol'], planLimits: limits(usedPercent, resetsAt) }) as unknown as ConnectionSummary
const claude = (usedPercent = 10) => ({ ...base, id: 'mac-claude', name: 'Claude', provider: 'claude', models: ['claude-opus-5-5'], planLimits: limits(usedPercent, RESET) }) as unknown as ConnectionSummary
const key = { ...base, id: 'openai-key', name: 'OpenAI', provider: 'openai', models: ['gpt-paid'] } as unknown as ConnectionSummary
const local = { ...base, id: 'ollama', name: 'This Mac', provider: 'custom', models: ['llama'] } as unknown as ConnectionSummary
const pick = { connectionId: 'mac-chatgpt', model: 'gpt-6-sol' }

test('a reading blocks a start only when it is certain: a full window whose reset is still ahead', () => {
    expect(desktopPlanWait(limits(100, RESET), NOW)).toEqual({ state: 'waiting', resetsAt: RESET })
    expect(desktopPlanWait(limits(100, '2026-11-16T09:00:00.000Z'), NOW)).toEqual({ state: 'ok', resetsAt: null })
    expect(desktopPlanWait(limits(100, null), NOW)).toEqual({ state: 'unknown', resetsAt: null })
    expect(desktopPlanWait(limits(99, RESET), NOW).state).toBe('ok')
    expect(desktopPlanWait(null, NOW).state).toBe('ok')
    // Session and week both full: wait for the later of the two.
    expect(desktopPlanWait({ capturedAt: '', windows: [{ kind: 'session', label: null, usedPercent: 100, resetsAt: RESET }, { kind: 'weekly', label: null, usedPercent: 100, resetsAt: '2026-11-20T00:00:00.000Z' }] }, NOW).resetsAt).toBe('2026-11-20T00:00:00.000Z')
})

test('work waits until the reset time, or checks every 15 minutes for at most 24 hours', () => {
    expect(desktopUsagePark(NOW, RESET)).toEqual({ parkedAt: NOW.toISOString(), resetsAt: RESET, nextCheckAt: '2026-11-16T15:00:30.000Z', recheckSince: null })
    const first = desktopUsagePark(NOW, null) as DesktopUsageParking
    expect(first).toEqual({ parkedAt: NOW.toISOString(), resetsAt: null, nextCheckAt: '2026-11-16T10:15:00.000Z', recheckSince: NOW.toISOString() })
    const later = new Date(NOW.getTime() + 23.9 * 3_600_000)
    expect(desktopUsagePark(later, null, first)).toMatchObject({ parkedAt: NOW.toISOString(), recheckSince: NOW.toISOString() })
    expect(desktopUsagePark(new Date(NOW.getTime() + 24 * 3_600_000), null, first)).toBe('expired')
    // A reset time that has already passed is not a time to wait for.
    expect(desktopUsagePark(NOW, '2026-11-16T09:00:00.000Z')).toMatchObject({ resetsAt: null })
})

test('the backup is only ever the pair the owner saved: never a paid key picked for them', () => {
    const all = [chatgpt(), claude(), key, local]
    // No backup saved: nothing, even with another plan, a key and a local model all connected.
    expect(desktopBackupPick(null, all, 'mac-chatgpt', NOW)).toBeNull()
    // A plan with usage left.
    expect(desktopBackupPick({ connectionId: 'mac-claude', model: 'claude-opus-5-5' }, all, 'mac-chatgpt', NOW)).toMatchObject({ connectionId: 'mac-claude', name: 'Claude' })
    // A plan that is itself out of usage is not used, and nothing else is used in its place.
    expect(desktopBackupPick({ connectionId: 'mac-claude', model: 'claude-opus-5-5' }, [chatgpt(), claude(100), key, local], 'mac-chatgpt', NOW)).toBeNull()
    // A key or a local model the owner explicitly picked.
    expect(desktopBackupPick({ connectionId: 'openai-key', model: 'gpt-paid' }, all, 'mac-chatgpt', NOW)).toMatchObject({ connectionId: 'openai-key', model: 'gpt-paid' })
    expect(desktopBackupPick({ connectionId: 'ollama', model: 'llama' }, all, 'mac-chatgpt', NOW)).toMatchObject({ connectionId: 'ollama' })
    // The plan that is out cannot back itself up; a disconnected or unknown pair is no backup.
    expect(desktopBackupPick({ connectionId: 'mac-chatgpt', model: 'gpt-6-sol' }, all, 'mac-chatgpt', NOW)).toBeNull()
    expect(desktopBackupPick({ connectionId: 'openai-key', model: 'not-offered' }, all, 'mac-chatgpt', NOW)).toBeNull()
    expect(desktopBackupPick({ connectionId: 'openai-key', model: 'gpt-paid' }, [chatgpt(), { ...key, connected: false }], 'mac-chatgpt', NOW)).toBeNull()
})

test('a chat send on a plan that is out is refused with the reset time when no backup may answer', () => {
    const refused = (() => { try { gateDesktopPick([chatgpt(), claude(), key], pick, null, NOW); return null } catch (error) { return error } })()
    expect(refused).toBeInstanceOf(DesktopPlanOutHttpError)
    expect(refused).toMatchObject({ status: 409, code: 'plan_out_of_usage', resetsAt: RESET, plan: { connectionId: 'mac-chatgpt', name: 'ChatGPT', provider: 'codex' } })
    expect((refused as Error).message).toMatch(/^ChatGPT usage limit reached\. It resets at /)
})

test('the backup answers instead, with the note that says why', () => {
    expect(gateDesktopPick([chatgpt(), claude(), key], pick, { connectionId: 'mac-claude', model: 'claude-opus-5-5' }, NOW))
        .toEqual({ connectionId: 'mac-claude', model: 'claude-opus-5-5', note: expect.stringMatching(/^Backup model is answering on Claude · .+: ChatGPT is out of usage\.$/) })
})

test('a plan with usage left, an uncertain reading, and a key are all left alone', () => {
    const backup = { connectionId: 'mac-claude', model: 'claude-opus-5-5' }
    expect(gateDesktopPick([chatgpt(40), claude()], pick, backup, NOW)).toBe(pick)
    expect(gateDesktopPick([chatgpt(100, null), claude()], pick, backup, NOW)).toBe(pick)
    const paid = { connectionId: 'openai-key', model: 'gpt-paid' }
    expect(gateDesktopPick([chatgpt(), key], paid, backup, NOW)).toBe(paid)
})

test('a preset with nothing to run on names the plan it is waiting for', () => {
    expect(desktopPlanOutOfPreset('smart', [chatgpt(), key], NOW)?.id).toBe('mac-chatgpt')
    expect(desktopPlanOutOfPreset('smart', [key], NOW)).toBeNull()
})
