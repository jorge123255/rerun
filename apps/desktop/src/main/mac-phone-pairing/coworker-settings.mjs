// The Electron shell is staged without application dependencies. Keep this outer admission check
// independent of the desktop routes, which validate the request again against the live coworker.
const agentId = /^[A-Za-z0-9_-]{1,200}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = value => typeof value === 'string' && uuid.test(value)
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const keys = (body, names) => Object.keys(body).length === names.length && names.every(name => Object.hasOwn(body, name))
const ids = value => Array.isArray(value) && value.length <= 100 && value.every(isUuid)

function settingsQuery(_device, search) {
    const id = search.get('agentId')
    return search.size === 1 && id && agentId.test(id) ? { agentId: id } : null
}

const editable = {
    description: value => typeof value === 'string' && value.length <= 2000,
    soul: value => text(value, 100_000),
    verbosity: value => ['minimal', 'concise', 'normal', 'detailed'].includes(value),
    suggestedReplies: value => typeof value === 'boolean',
    memoryEnabled: value => typeof value === 'boolean',
    autoMemory: value => typeof value === 'boolean',
    repository: value => value === null || (typeof value === 'string' && value.length <= 300),
}
const mutations = [
    ['PATCH', 'model', body => body.action === 'follow-workspace' ? keys(body, ['action'])
        : body.action === 'coworker' && keys(body, ['action', 'connectionId', 'model']) && text(body.connectionId, 256) && text(body.model, 256)],
    ['PUT', 'effort', body => keys(body, ['connectionId', 'model', 'effort']) && text(body.connectionId, 256) && text(body.model, 256)
        && (body.effort === null || text(body.effort, 32))],
    ['PATCH', 'tools', body => keys(body, ['group', 'id', 'enabled']) && typeof body.enabled === 'boolean'
        && (body.group === 'claude' ? body.id === 'claudeSubagents' : ['rerun', 'codex'].includes(body.group) && text(body.id, 256))],
    ['PATCH', 'call-targets', body => keys(body, ['targetAgentIds', 'expectedTargetAgentIds'])
        && ids(body.targetAgentIds) && ids(body.expectedTargetAgentIds)],
    ['PATCH', 'settings', body => Object.keys(body).length > 0
        && Object.entries(body).every(([key, value]) => Object.hasOwn(editable, key) && editable[key](value))],
    ['PATCH', 'name', body => keys(body, ['name']) && text(body.name, 60)],
    ['PATCH', 'enabled', body => keys(body, ['enabled']) && typeof body.enabled === 'boolean'],
    ['POST', 'box', body => keys(body, ['requestId', 'spaceId', 'expectedRevision']) && isUuid(body.requestId)
        && isUuid(body.spaceId) && Number.isSafeInteger(body.expectedRevision) && body.expectedRevision >= 0],
    ['POST', 'setup', body => keys(body, ['requestId', 'action', 'expectedRevision']) && isUuid(body.requestId)
        && ['start', 'continue', 'skip'].includes(body.action) && text(body.expectedRevision, 256)],
]

export const coworkerSettingsResources = [
    ['GET coworker-settings', { to: 'coworker-settings', query: settingsQuery, grant: 'changeSettings', settingsRefusals: true }],
    ['GET coworker-settings/setup', { to: 'coworker-settings/setup', query: settingsQuery, grant: 'changeSettings', settingsRefusals: true }],
    ...mutations.map(([method, field, accepts]) => {
        const to = 'coworker-settings/' + field
        return [method + ' ' + to, {
            to, query: settingsQuery, needs: 'changeSettings', settingsRefusals: true,
            // An instructions edit may carry up to 100,000 characters, including JSON escapes.
            ...(field === 'settings' && { limit: 640 * 1024 }),
            body: (_device, body) => accepts(body) ? { send: body, receipt: result => result?.ok === true ? { ok: true } : null } : null,
        }]
    }),
]
