import { expect, test, vi } from 'vitest'
import type { DesktopCoworkerCallTarget } from '../../../../../packages/contracts/src/desktop-coworker-calls.ts'
import {
    createDesktopCoworkerMentionsApi,
    DESKTOP_COWORKER_MENTION_TARGET_LIMIT,
    validateDesktopCoworkerMentionsAtSend,
    type DesktopCoworkerMentionRosterAuthority,
} from '@/lib/desktop/server/coworker-mentions'
import type { DesktopCoworkerMention } from './coworker-mention-model'

const target = (patch: Partial<DesktopCoworkerCallTarget> = {}): DesktopCoworkerCallTarget => ({ agentId: 'peer-1', name: 'Ada', handle: 'ada', boxName: 'Research', enabled: true, callable: true, ...patch })
const authority = (rows: readonly DesktopCoworkerCallTarget[]): DesktopCoworkerMentionRosterAuthority => ({ listTargets: vi.fn(async () => rows) })

test('GET returns a valid empty roster distinctly and projects only safe canonical fields', async () => {
    const empty = createDesktopCoworkerMentionsApi(authority([]))
    expect(await (await empty(new Request('http://local/mentions'), 'owner')).json()).toEqual({ targets: [] })
    const privateRow = { ...target(), engineId: 'private-engine', privateContext: 'do not expose' } as DesktopCoworkerCallTarget
    const api = createDesktopCoworkerMentionsApi(authority([privateRow, target({ agentId: 'owner' })]))
    const response = await api(new Request('http://local/mentions'), 'owner')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ targets: [{ agentId: 'peer-1', name: 'Ada', handle: 'ada', boxName: 'Research', enabled: true, callable: true }] })
})

test('duplicate names remain selectable by ID but duplicate local IDs are rejected', async () => {
    const rows = [target(), target({ agentId: 'peer-2', handle: 'ada' })]
    const api = createDesktopCoworkerMentionsApi(authority(rows))
    expect((await (await api(new Request('http://local/mentions'), 'owner')).json()).targets).toHaveLength(2)
    const duplicate = createDesktopCoworkerMentionsApi(authority([target(), target()]))
    expect((await duplicate(new Request('http://local/mentions'), 'owner')).status).toBe(502)
})

test('response limits reject rather than silently truncate a roster', async () => {
    const rows = Array.from({ length: DESKTOP_COWORKER_MENTION_TARGET_LIMIT + 1 }, (_, index) => target({ agentId: `peer-${index}` }))
    const api = createDesktopCoworkerMentionsApi(authority(rows))
    const response = await api(new Request('http://local/mentions'), 'owner')
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'Coworker suggestion roster exceeded its safe limit.' })
})

test('deadlines and superseded requests cancel authority without turning empty into error', async () => {
    const listTargets = vi.fn((_owner: string, { signal }: { signal: AbortSignal }) => new Promise<readonly DesktopCoworkerCallTarget[]>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const api = createDesktopCoworkerMentionsApi({ listTargets }, { timeoutMs: 1 })
    const response = await api(new Request('http://local/mentions'), 'owner')
    expect(response.status).toBe(504)
    const controller = new AbortController(); controller.abort()
    expect((await api(new Request('http://local/mentions', { signal: controller.signal }), 'owner')).status).toBe(408)
    expect(listTargets).toHaveBeenCalledTimes(1)
})

test('server send validation performs a fresh read-only ID check and never dispatches', async () => {
    const roster = authority([target({ name: 'Renamed', handle: 'new' }), target({ agentId: 'peer-2', name: 'Renamed' })])
    const mentions: DesktopCoworkerMention[] = [{ targetId: 'peer-1', token: '@ada', start: 0, end: 4 }]
    const result = await validateDesktopCoworkerMentionsAtSend(roster, { agentId: 'owner', text: '@ada review', mentions })
    expect(result).toMatchObject({ ok: true, mentions: [{ targetId: 'peer-1', target: { agentId: 'peer-1', name: 'Renamed' } }] })
    expect(roster.listTargets).toHaveBeenCalledExactlyOnceWith('owner', { signal: expect.any(AbortSignal) })
})

test.each([
    ['edited range', '@adaX edited', [{ targetId: 'peer-1', token: '@ada', start: 0, end: 4 }], 'range'],
    ['deleted target', '@ada review', [{ targetId: 'missing', token: '@ada', start: 0, end: 4 }], 'target'],
    ['disabled target', '@ada review', [{ targetId: 'disabled', token: '@ada', start: 0, end: 4 }], 'target'],
] as const)('server send refuses a %s without granting or calling', async (_reason, text, mentions, code) => {
    const roster = authority([target(), target({ agentId: 'disabled', enabled: false })])
    await expect(validateDesktopCoworkerMentionsAtSend(roster, { agentId: 'owner', text, mentions })).resolves.toMatchObject({ ok: false, code })
    expect(roster.listTargets).toHaveBeenCalledTimes(1)
})
