import type { MacPhoneCoworkerSettings } from '@rerun/mac-contracts/mac-phone-pairing'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Alert } from 'react-native'

import { isSwitchDisabled } from '@/test/switch'

import { MacCoworkerSettingsScreen } from './MacCoworkerSettingsScreen'

const mockParams: { id: string; page?: string } = { id: 'ada' }
jest.mock('expo-router', () => ({
    router: { push: jest.fn(), back: jest.fn() },
    useLocalSearchParams: () => mockParams,
    useFocusEffect: (effect: () => () => void) => jest.requireActual('react').useEffect(effect, [effect]),
}))
jest.mock('expo-crypto', () => ({ randomUUID: () => '930b91e3-d0fb-4225-b144-03e39c752cfa' }))
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default)
jest.mock('react-native-svg', () => ({ __esModule: true, default: () => null, Path: () => null }))

const tool = { id: 'workspaceRead', label: 'Read workspace files', description: 'Read a visible text file in this coworker’s Files panel.', enabled: false, available: true, confirmOnEnable: true }
const value: MacPhoneCoworkerSettings = {
    agentId: 'ada', name: 'Ada', description: '', enabled: true, permissions: { changeSettings: true },
    settings: { soul: 'Check facts.', soulEditable: true, verbosity: 'normal', repository: null, workspaceReadEnabled: false, suggestedReplies: true, memoryEnabled: false, autoMemory: false, selfImprovementEnabled: true },
    model: { coworker: null, effective: { model: 'terra', provider: 'codex', connectionId: 'c', available: true, label: 'Terra', reasoning: { effort: 'medium', source: 'model-default' }, reasoningOptions: ['medium', 'high'] },
        catalog: [{ connectionId: 'c', name: 'Codex', provider: 'codex', models: [{ id: 'terra', label: 'Terra' }, { id: 'extra', label: 'Extra' }] }] },
    tools: { rerun: [tool, { ...tool, id: 'callAgent', label: 'Call coworkers', enabled: true, confirmOnEnable: false }], codex: [{ ...tool, id: 'shell', label: 'Run shell commands' }] },
    callTargets: { targets: [{ agentId: 'bo', name: 'Bo', enabled: true, callable: false }], allowedTargetIds: [] },
    board: { revision: 10, spaceId: null, spaces: [{ id: 'box1', name: 'Reports' }] },
    setup: { revision: 'setup-now', required: true, pending: true, skipped: false, completedAt: null, canStart: true, canSkip: true },
}

const fakeHub = (snapshot = value) => ({
    readCoworkerSettings: jest.fn(async () => snapshot),
    changeCoworkerSettings: jest.fn(async () => {}),
    unconfirmedSettingsChange: jest.fn(() => null),
})
afterEach(() => { jest.restoreAllMocks(); delete mockParams.page })

it('shows an approved read-only phone the settings and Mac-only credential rows with no edit actions', async () => {
    const hub = fakeHub({ ...value, permissions: { changeSettings: false } })
    await render(<MacCoworkerSettingsScreen hub={hub} />)
    await screen.findByText('Ada')
    expect(screen.getByText(/To edit, turn on Change settings/)).toBeTruthy()
    expect(isSwitchDisabled(screen.getByLabelText('Switched on'))).toBe(true)
    expect(screen.getAllByText('Set on your Mac')).toHaveLength(4)
    for (const label of ['Vault entries', 'Provider sign-ins', 'MCP server secrets', 'Service accounts']) {
        expect(screen.getByText(label)).toBeTruthy()
        expect(screen.queryByRole('button', { name: label })).toBeNull()
        expect(screen.queryByLabelText(label)).toBeNull()
    }
    expect(hub.changeCoworkerSettings).not.toHaveBeenCalled()
})

it.each([['rerun', 'Read workspace files', 'workspaceRead'], ['codex', 'Run shell commands', 'shell']])('asks before enabling a Mac-reaching %s tool, and cancellation leaves it off', async (page, label, id) => {
    mockParams.page = page
    const hub = fakeHub()
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    await render(<MacCoworkerSettingsScreen hub={hub} />)
    const toggle = await screen.findByLabelText(label)
    await fireEvent(toggle, 'valueChange', true)
    expect(alert).toHaveBeenCalledWith(`Allow ${label}?`, tool.description, expect.any(Array))
    const actions = alert.mock.calls[0][2]!
    expect(actions[0].style).toBe('cancel')
    expect(hub.changeCoworkerSettings).not.toHaveBeenCalled()
    await act(async () => { actions[1].onPress?.() })
    expect(hub.changeCoworkerSettings).toHaveBeenCalledWith('ada', { field: 'tools', body: { group: page, id, enabled: true } }, expect.anything())
})

it('allows an existing permission to be revoked even if its prerequisite has gone away', async () => {
    mockParams.page = 'rerun'
    const hub = fakeHub({ ...value, tools: { ...value.tools, rerun: [{ ...tool, enabled: true, available: false }] } })
    const alert = jest.spyOn(Alert, 'alert')
    await render(<MacCoworkerSettingsScreen hub={hub} />)
    await fireEvent(await screen.findByLabelText(tool.label), 'valueChange', false)
    expect(alert).not.toHaveBeenCalled()
    expect(hub.changeCoworkerSettings).toHaveBeenCalledWith('ada', { field: 'tools', body: { group: 'rerun', id: tool.id, enabled: false } }, expect.anything())
})

it('keeps the saved targets as the write precondition and displays the Mac refusal verbatim', async () => {
    mockParams.page = 'targets'
    const hub = fakeHub({ ...value, callTargets: { ...value.callTargets, allowedTargetIds: ['other'] } })
    hub.changeCoworkerSettings.mockRejectedValueOnce(new Error('Stop this coworker’s current reply before editing its tools.'))
    jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    await render(<MacCoworkerSettingsScreen hub={hub} />)
    await fireEvent(await screen.findByLabelText('Bo'), 'valueChange', true)
    expect(hub.changeCoworkerSettings).toHaveBeenCalledWith('ada', { field: 'call-targets', body: { expectedTargetAgentIds: ['other'], targetAgentIds: ['other', 'bo'] } }, expect.anything())
    expect(await screen.findByText('Stop this coworker’s current reply before editing its tools.')).toBeTruthy()
    expect(hub.readCoworkerSettings).toHaveBeenCalledTimes(2)
})

it('re-reads the settings switch when the Mac revokes it between reading and saving', async () => {
    const hub = fakeHub()
    hub.readCoworkerSettings.mockResolvedValueOnce(value).mockResolvedValue({ ...value, permissions: { changeSettings: false } })
    hub.changeCoworkerSettings.mockRejectedValueOnce(new Error('settings_not_allowed'))
    jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    await render(<MacCoworkerSettingsScreen hub={hub} />)
    await fireEvent(await screen.findByLabelText('Switched on'), 'valueChange', false)
    await waitFor(() => { expect(isSwitchDisabled(screen.getByLabelText('Switched on'))).toBe(true) })
    expect(hub.changeCoworkerSettings).toHaveBeenCalledTimes(1)
})

it.each([
    ['model', 'radio', 'Extra', { field: 'model', body: { action: 'coworker', connectionId: 'c', model: 'extra' } }],
    ['profile', 'radio', 'Reports', { field: 'box', body: { expectedRevision: 10, spaceId: 'box1', requestId: '930b91e3-d0fb-4225-b144-03e39c752cfa' } }],
    ['setup', 'button', 'Skip setup', { field: 'setup', body: { expectedRevision: 'setup-now', action: 'skip', requestId: '930b91e3-d0fb-4225-b144-03e39c752cfa' } }],
] as const)('uses the offered setting and its current scope for %s / %s / %s', async (page, role, name, change) => {
    mockParams.page = page
    const hub = fakeHub()
    await render(<MacCoworkerSettingsScreen hub={hub} />)
    await fireEvent.press(await screen.findByRole(role, { name }))
    expect(hub.changeCoworkerSettings).toHaveBeenCalledWith('ada', change, expect.anything())
})

it('saves the offered reasoning stop and resets the current model using the same slider', async () => {
    mockParams.page = 'model'
    const hub = fakeHub()
    const active = { ...value, model: { ...value.model, effective: { ...value.model.effective, reasoning: { source: 'model' as const, effort: 'high' } } } }
    hub.readCoworkerSettings.mockResolvedValueOnce(value).mockResolvedValueOnce(active).mockResolvedValue(value)
    await render(<MacCoworkerSettingsScreen hub={hub} />)
    const slider = await screen.findByRole('adjustable', { name: 'Reasoning effort' })
    await fireEvent.layout(slider, { width: 236, height: 44 })
    expect(screen.getByText('Default · Medium')).toBeTruthy()
    await fireEvent(slider, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } })
    expect(await screen.findByText('High')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Use this model’s default effort' }))
    expect(hub.changeCoworkerSettings.mock.calls).toEqual(['high', null].map(effort => [
        'ada', { field: 'effort', body: { connectionId: 'c', model: 'terra', effort } }, expect.anything(),
    ]))
    expect(await screen.findByText('Default · Medium')).toBeTruthy()
})

it.each(['setup', 'profile'] as const)('can retry the original %s action after the Mac advanced its revision before acknowledging', async page => {
    mockParams.page = page
    const hub = fakeHub()
    const refreshed = { ...value, board: { ...value.board, revision: 11, spaceId: 'box1' }, setup: { ...value.setup, revision: 'after', skipped: true, canSkip: false } }
    hub.readCoworkerSettings.mockResolvedValueOnce(value).mockResolvedValue(refreshed)
    hub.changeCoworkerSettings.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }))
    jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    await render(<MacCoworkerSettingsScreen hub={hub} />)
    await fireEvent.press(await screen.findByRole(page === 'setup' ? 'button' : 'radio', { name: page === 'setup' ? 'Skip setup' : 'Reports' }))
    const first = hub.changeCoworkerSettings.mock.calls[0]
    await fireEvent.press(await screen.findByRole('button', { name: 'Retry' }))
    expect(hub.changeCoworkerSettings.mock.calls[1]).toEqual(first)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})

it('edits the Claude sub-agent grant through the row projected by the Mac', async () => {
    const label = 'Use Claude Code sub-agents'
    const description = 'Sub-agents work on parts of a reply and use your Claude subscription.'
    const hub = fakeHub({ ...value, tools: { ...value.tools, claude: [{ ...tool, id: 'claudeSubagents', label, description, confirmOnEnable: true }] } })
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    const view = await render(<MacCoworkerSettingsScreen hub={hub} />)
    expect(await screen.findByRole('button', { name: 'Claude Code tools' })).toBeTruthy()
    mockParams.page = 'claude'
    await view.rerender(<MacCoworkerSettingsScreen hub={hub} />)
    await fireEvent(await screen.findByLabelText(label), 'valueChange', true)
    expect(alert).toHaveBeenCalledWith(`Allow ${label}?`, description, expect.any(Array))
    expect(hub.changeCoworkerSettings).not.toHaveBeenCalled()
    await act(async () => { alert.mock.calls[0][2]![1].onPress?.() })
    expect(hub.changeCoworkerSettings).toHaveBeenCalledWith('ada', { field: 'tools', body: { group: 'claude', id: 'claudeSubagents', enabled: true } }, expect.anything())
})

it.each([{ shape: 'older Mac', claude: undefined }, { shape: 'empty group', claude: [] }])('hides Claude tools for a Mac without a projected Claude row ($shape)', async ({ claude }) => {
    mockParams.page = 'claude'
    const hub = fakeHub({ ...value, tools: { ...value.tools, claude } })
    await render(<MacCoworkerSettingsScreen hub={hub} />)
    expect(await screen.findByText('Ada')).toBeTruthy()
    expect(screen.queryByText('Claude Code tools')).toBeNull()
    expect(screen.queryByLabelText('Use Claude Code sub-agents')).toBeNull()
    expect(hub.changeCoworkerSettings).not.toHaveBeenCalled()
})

it('can revoke a paused Claude grant and cannot re-enable it while unavailable', async () => {
    mockParams.page = 'claude'
    const row = { ...tool, id: 'claudeSubagents' as const, label: 'Use Claude Code sub-agents', enabled: true, available: false, unavailableReason: 'Choose a Claude Code model.' }
    const hub = fakeHub()
    hub.readCoworkerSettings.mockResolvedValueOnce({ ...value, tools: { ...value.tools, claude: [row] } })
        .mockResolvedValue({ ...value, tools: { ...value.tools, claude: [{ ...row, enabled: false }] } })
    const alert = jest.spyOn(Alert, 'alert')
    await render(<MacCoworkerSettingsScreen hub={hub} />)
    const toggle = await screen.findByLabelText(row.label)
    expect(isSwitchDisabled(toggle)).toBe(false)
    await fireEvent(toggle, 'valueChange', false)
    expect(hub.changeCoworkerSettings).toHaveBeenCalledWith('ada', { field: 'tools', body: { group: 'claude', id: row.id, enabled: false } }, expect.anything())
    expect(alert).not.toHaveBeenCalled()
    expect(isSwitchDisabled(screen.getByLabelText(row.label))).toBe(true)
})
