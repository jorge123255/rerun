import { describe, expect, test } from 'vitest'
import type { ComputerPanelProjection } from './contract'
import { dismissKey, launchAvailability, ownerOf, presentComputerPanel } from './controller'

const G = 'a'.repeat(32)
const base = (over: Partial<ComputerPanelProjection> = {}): ComputerPanelProjection => ({
    workspaceId: 'ws1', generation: G, coworker: { enabled: true, deleted: false }, takeover: null, runtime: { kind: 'running' },
    grants: { computer: true, browser: true, terminalLaunch: true, filesLaunch: true }, capability: { terminalInstalled: true, filesInstalled: true }, humanDriving: false,
    current: { agentId: 'a1', sessionId: 's1', runId: 'r1', liveScreen: { kind: 'computer', site: 'example.com' } }, ...over,
})
const view = { agentId: 'a1', sessionId: 's1', active: true, selected: true, visible: true }
const none = new Set<string>()

describe('presentComputerPanel', () => {
    test('shows only for the exact trusted live run', () => {
        expect(presentComputerPanel(base(), view, none)).toMatchObject({ show: true, mode: 'model', site: 'example.com' })
        expect(presentComputerPanel(base({ current: null }), view, none)).toMatchObject({ show: false, reason: 'no-run' })
        // History: run present but no live screen never opens, regardless of saved tool parts.
        expect(presentComputerPanel(base({ current: { agentId: 'a1', sessionId: 's1', runId: 'r0', liveScreen: null } }), view, none)).toMatchObject({ show: false, reason: 'no-screen' })
    })
    test('owner change: other coworker/session is a mismatch', () => {
        expect(presentComputerPanel(base(), { ...view, agentId: 'a2' }, none)).toMatchObject({ show: false, reason: 'mismatch' })
        expect(presentComputerPanel(base(), { ...view, sessionId: 's2' }, none)).toMatchObject({ show: false, reason: 'mismatch' })
    })
    test('inactive tab, hidden app, disabled/deleted coworker never show', () => {
        expect(presentComputerPanel(base(), { ...view, active: false }, none)).toMatchObject({ reason: 'inactive' })
        expect(presentComputerPanel(base(), { ...view, visible: false }, none)).toMatchObject({ reason: 'hidden' })
        expect(presentComputerPanel(base({ coworker: { enabled: false, deleted: false } }), view, none)).toMatchObject({ reason: 'coworker-gone' })
        expect(presentComputerPanel(base({ coworker: { enabled: true, deleted: true } }), view, none)).toMatchObject({ reason: 'coworker-gone' })
    })
    test('runtime absence is reported truthfully', () => {
        expect(presentComputerPanel(base({ runtime: { kind: 'docker-absent' } }), view, none)).toMatchObject({ reason: 'runtime', runtimeReason: expect.stringContaining('Docker') })
        expect(presentComputerPanel(base({ runtime: { kind: 'container-stopped' } }), view, none)).toMatchObject({ reason: 'runtime' })
    })
    test('pending takeover is left to the accepted takeover card', () => {
        expect(presentComputerPanel(base({ takeover: { takeoverId: 'f'.repeat(64), reason: 'Sign in', url: 'https://x', opened: false } }), view, none)).toMatchObject({ reason: 'takeover-pending' })
    })
    test('manual dismissal suppresses duplicate events for the same owner only', () => {
        const owner = ownerOf(base())!
        const dismissed = new Set([dismissKey(owner, null)])
        for (let i = 0; i < 3; i++) expect(presentComputerPanel(base(), view, dismissed)).toMatchObject({ reason: 'dismissed' })
        expect(presentComputerPanel(base({ current: { agentId: 'a1', sessionId: 's1', runId: 'r2', liveScreen: { kind: 'browser', site: null } } }), view, dismissed)).toMatchObject({ show: true })
        expect(presentComputerPanel(base({ generation: 'b'.repeat(32) }), view, dismissed)).toMatchObject({ show: true })
    })
    test('invalid generation or workspace fails closed', () => {
        expect(ownerOf(base({ generation: 'nothex' }))).toBeNull()
        expect(ownerOf(base({ workspaceId: '' }))).toBeNull()
    })
    test('human driving is a distinct mode', () => {
        expect(presentComputerPanel(base({ humanDriving: true }), view, none)).toMatchObject({ mode: 'drive' })
    })
})

describe('launchAvailability', () => {
    const by = (p: ComputerPanelProjection | null, mounted = true) => Object.fromEntries(launchAvailability(p, mounted).map(a => [a.app, a.state]))
    test('original order Browser, Files, Terminal', () => expect(launchAvailability(base(), true).map(a => a.label)).toEqual(['Browser', 'Files', 'Terminal']))
    test('separate grants', () => {
        expect(by(base({ grants: { computer: true, browser: true, terminalLaunch: false, filesLaunch: true } }))).toEqual({ browser: 'ready', files: 'ready', terminal: 'permission-off' })
        expect(by(base({ grants: { computer: false, browser: true, terminalLaunch: true, filesLaunch: true } }))).toEqual({ browser: 'permission-off', files: 'permission-off', terminal: 'permission-off' })
        expect(by(base({ grants: { computer: true, browser: false, terminalLaunch: true, filesLaunch: true } })).browser).toBe('permission-off')
    })
    test('guest capability and busy', () => {
        expect(by(base({ capability: { terminalInstalled: false, filesInstalled: true } })).terminal).toBe('app-missing')
        expect(by(base({ humanDriving: true })).files).toBe('busy')
    })
    test('unmounted human launcher is refused, never ready', () => expect(by(base(), false)).toMatchObject({ files: 'refused', terminal: 'refused', browser: 'ready' }))
    test('no projection is refused', () => expect(by(null)).toEqual({ browser: 'refused', files: 'refused', terminal: 'refused' }))
})
