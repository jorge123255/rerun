import 'server-only'
import {
    desktopGithubRepositorySchema, macPhoneCoworkerSettingsViewSchema, macPhoneCoworkerSetupViewSchema,
    readDesktopGithubRepository, type MacPhoneCoworkerSettingsChange,
} from '@rerun/contracts'
import { z } from 'zod'
import { desktopModelViewSchema } from '../chat-model'
import type { CoworkerToolRow, CoworkerTools } from '../coworker-tools'
import type { DesktopCoworkerSettings } from '../coworker-settings'
import { desktopBoardStateSchema } from '../spaces'
import { DesktopHttpError, DESKTOP_SESSION_COOKIE } from './auth'
import { desktopCreationPendingMessage } from './creation-guard'
import type { DesktopRuntime } from './runtime'
import type { DesktopAgent } from './store'

// The same permission id and explanation come from the Mac tools catalogue. Pending/disabled
// rows stay in the projection with the Mac's reason. Enabling these also needs a phone prompt.
const macAccess = {
    rerun: new Set(['workspaceRead', 'workspaceSearch', 'workspaceList', 'cardFile', 'download', 'vision', 'webFetch', 'privateFileWrite', 'sharedFilesRead', 'sharedFilesWrite', 'guestShell', 'browser', 'computer', 'terminalLaunch', 'filesLaunch', 'localMcpStdio', 'toolInstall', 'nativeWriteback', 'repositoryWorkspace']),
    codex: new Set(['workspaceRead', 'workspaceWrite', 'shell', 'codeMode', 'images']),
}
// The Claude group is conditional on the installed Mac's actual Tools route, including
// its decision to show a previously enabled permission solely so the owner can revoke it.
type MacTools = Pick<CoworkerTools, 'rerun' | 'codex'> & { claude?: CoworkerToolRow[] }

const headers = { 'cache-control': 'no-store' }
const unavailable = 'Could not reach this coworker’s settings. Try again.'
// A canonical endpoint can relay an upstream error (for example the engine's model-effort
// error). Only known UI messages cross the pairing boundary, never its raw response or URL.
const userMessages = new Set([
    desktopCreationPendingMessage, 'This workspace is switching. Wait for it to finish.',
    'Choose a valid coworker setting to save.', 'A coworker name of 1–60 characters is required',
    'Choose a model offered by a connected provider.', 'Choose a reasoning effort this model offers.',
    'Choose this connection’s reasoning effort in Settings.', 'Could not save this coworker’s model. Try again.',
    'Could not save this model’s reasoning effort. Try again.', 'Could not confirm the coworker’s new name. Try again.',
    'This permission requires a coworker using Claude Code with your Claude subscription.',
    'This permission requires a coworker using Codex with your ChatGPT subscription.',
    'The permission could not change. Stop any active replies for this coworker and try again.',
    'Choose a valid tool permission.', 'This tool requires the direct Mac build.', 'This tool is unavailable for this coworker.',
    'File editing is paused for this coworker.', 'Shared files access is paused for this coworker.',
    'Turn on this coworker’s memory preference first.', 'Turn on Improve itself to change this permission.',
    'Could not reach this coworker’s tools. Try again.', 'This coworker is switched off and cannot run.',
    'This coworker is being deleted. Retry Delete to finish.', 'Coworker identity changed.',
    'Each allowed coworker can be listed once.', 'A coworker cannot allow a call to itself.',
    'An allowed coworker was not found.', 'Allowed coworkers changed. Reopen Tools before trying again.',
    'The board changed. Refresh it before trying again.', 'That Box has no room left. Free a cell in it first.',
    'Finish deleting this coworker before moving it.', 'This request was already used for another Box change.',
    'Finish the pending coworker copy before changing this Box.', 'Choose a valid Box change.',
    'The setup changed since it was read. Reload and try again.', 'This coworker does not have pending setup.',
    'Another setup change is being saved. Reload to resume it.', 'This setup request was already used for a different change.',
    'This setup change was refused. Reload and try again.', 'Could not confirm this setup change. Retry to resume the same attempt.',
    'Use owner/name or a link like https://github.com/owner/name.', 'Could not confirm whether this coworker is enabled. Try again.',
    unavailable,
])

class SettingsRefused extends DesktopHttpError {}

export function phoneSettingsRefusal(error: unknown): Response {
    if (!(error instanceof SettingsRefused)) throw error
    return Response.json({ error: 'settings_refused', message: error.message }, { status: error.status, headers })
}

type LocalRequest = (path: string, method?: string, body?: unknown) => Promise<Response>

export function phoneSettingsMacRequest(runtime: DesktopRuntime, signal: AbortSignal): LocalRequest {
    // The authenticated supervisor runtime owns this origin and cookie. No URL, header, or
    // redirect supplied by a phone can choose where they are sent.
    return (path, method = 'GET', body) => fetch(new URL('/api/desktop/' + path, runtime.app.origin), {
        method, redirect: 'error', cache: 'no-store', signal,
        headers: { Cookie: DESKTOP_SESSION_COOKIE + '=' + runtime.app.sessionToken, Origin: runtime.app.origin, Accept: 'application/json', ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
    })
}

async function accepted(response: Response) {
    if (response.ok) return response
    if ([404, 401].includes(response.status)) throw new DesktopHttpError(404, 'Not found')
    const value = await response.json().catch(() => null)
    throw new SettingsRefused(response.status, userMessages.has(value?.error) ? value.error : unavailable)
}

async function read(mac: LocalRequest, path: string) {
    return (await accepted(await mac(path))).json()
}

export async function readPhoneCoworkerSetup(owner: DesktopAgent, mac: LocalRequest) {
    const id = encodeURIComponent(owner.id)
    const setup = macPhoneCoworkerSetupViewSchema.parse({ ...await read(mac, 'coworkers/' + id + '/setup?observe=1'), agentId: owner.id })
    if (setup.canStart) {
        const model = desktopModelViewSchema.parse(await read(mac, 'agents/' + id + '/model?presets=1'))
        return { ...setup, canStart: model.effective.available }
    }
    return setup
}

export async function readPhoneCoworkerSettings(owner: DesktopAgent, mac: LocalRequest) {
    const id = encodeURIComponent(owner.id)
    const [settings, model, tools, callTargets, board, setup] = await Promise.all([
        read(mac, 'agents/' + id + '/settings') as Promise<DesktopCoworkerSettings>,
        read(mac, 'agents/' + id + '/model?presets=1').then(result => desktopModelViewSchema.parse(result)),
        read(mac, 'agents/' + id + '/tools') as Promise<MacTools>,
        read(mac, 'coworkers/' + id + '/call-targets'),
        read(mac, 'spaces').then(result => desktopBoardStateSchema.parse(result.board)),
        read(mac, 'coworkers/' + id + '/setup?observe=1').then(result => macPhoneCoworkerSettingsViewSchema.shape.setup.parse(result)),
    ])
    const repo = settings.repository && desktopGithubRepositorySchema.safeParse({ owner: settings.repository.owner, name: settings.repository.name })
    const rows = (group: keyof typeof macAccess) => tools[group].map(row => ({ ...row, confirmOnEnable: macAccess[group].has(row.id) }))
    const provider = model.effective.presetProvider ?? model.effective.provider
    return macPhoneCoworkerSettingsViewSchema.parse({
        agentId: owner.id, name: owner.name, description: settings.description ?? owner.description, enabled: owner.enabled,
        settings: { ...settings, repository: repo?.success ? repo.data.owner + '/' + repo.data.name : null },
        model,
        tools: {
            rerun: rows('rerun'), codex: provider === 'codex' ? rows('codex') : [],
            ...(tools.claude && { claude: tools.claude.filter(row => row.id === 'claudeSubagents').map(row => ({ ...row, confirmOnEnable: false })) }),
        },
        callTargets,
        board: { revision: board.revision, spaces: board.spaces, spaceId: board.placements.find(p => p.agentId === owner.id)?.spaceId ?? null },
        setup: { ...setup, canStart: setup.canStart && model.effective.available },
    })
}

export const phoneSettingsMethods = {
    model: 'PATCH', effort: 'PUT', settings: 'PATCH', tools: 'PATCH', 'call-targets': 'PATCH',
    enabled: 'PATCH', name: 'PATCH', box: 'POST', setup: 'POST',
} as const satisfies Record<MacPhoneCoworkerSettingsChange['field'], string>

export async function savePhoneCoworkerSettings(owner: DesktopAgent, change: MacPhoneCoworkerSettingsChange, mac: LocalRequest) {
    const id = encodeURIComponent(owner.id)
    const agent = 'agents/' + id
    const coworker = 'coworkers/' + id
    const routes = {
        name: agent, settings: agent + '/settings', model: agent + '/model', enabled: agent + '/enabled', tools: agent + '/tools',
        effort: 'model-effort', 'call-targets': coworker + '/call-targets', setup: coworker + '/setup', box: 'spaces',
    }
    if (change.field === 'effort' || (change.field === 'tools' && change.body.group === 'codex')) {
        const { effective } = desktopModelViewSchema.parse(await read(mac, agent + '/model?presets=1'))
        if (change.field === 'effort' && (!effective.available || effective.connectionId !== change.body.connectionId || effective.model !== change.body.model))
            throw new SettingsRefused(409, 'This coworker’s model changed. Reopen settings before trying again.')
        if (change.field === 'tools' && (effective.presetProvider ?? effective.provider) !== 'codex')
            throw new SettingsRefused(409, 'Choose a ChatGPT (Codex) model for this coworker first.')
    }
    if (change.field === 'tools' && change.body.group === 'claude') {
        const tools: MacTools = await read(mac, agent + '/tools')
        const row = tools.claude?.find(row => row.id === 'claudeSubagents')
        if (!row || (!row.available && (change.body.enabled || !row.enabled))) {
            const reason = row?.unavailableReason
            throw new SettingsRefused(400, reason && userMessages.has(reason) ? reason : 'This tool is unavailable for this coworker.')
        }
    }
    if (change.field === 'call-targets') {
        const tools: CoworkerTools = await read(mac, agent + '/tools')
        if (!tools.rerun.some(row => row.id === 'callAgent' && row.enabled && row.available))
            throw new SettingsRefused(409, 'Turn on Call coworkers first.')
    }
    // The board normally constructs this command around its own coworker id.
    let body: unknown = change.body
    if (change.field === 'box') body = { expectedRevision: change.body.expectedRevision, requestId: change.body.requestId, command: { kind: 'move-agent', agentId: owner.id, spaceId: change.body.spaceId } }
    if (change.field === 'settings' && change.body.repository) {
        const value = change.body.repository
        const repo = !/[?#]/.test(value) && readDesktopGithubRepository(value)
        if (!repo) throw new SettingsRefused(400, 'Use owner/name or a link like https://github.com/owner/name.')
        body = { ...change.body, repository: repo.owner + '/' + repo.name }
    }
    const response = await accepted(await mac(routes[change.field], phoneSettingsMethods[change.field], body))
    // Some canonical responses include whole board or model state. A mutation needs a receipt
    // only. A subsequent read obtains the current allowlisted settings from their owners.
    await response.body?.cancel()
    return { ok: true }
}

export const phoneSettingsAgentId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/)
