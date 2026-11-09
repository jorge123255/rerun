import { desktopTemplateRouteAllowed } from './templates/allow.js'
import { DESKTOP_CODEX_ID, desktopCodexAvailable } from './codex-runtime.js'
import { DESKTOP_CLAUDE_CONNECTION_ID, registeredCustomConnectionIdSchema } from '@rerun/contracts'
import { desktopClaudeAvailable } from './claude-plan/runtime.js'
import { desktopBrainPagesRouteAllowed } from './brain-pages-policy.js'
import { badRequest } from '../lib/errors.js'

export const desktopApp = (): boolean => process.env.RERUN_DESKTOP_APP === '1'

const API_PROVIDERS = new Set(['openai', 'anthropic', 'google', 'openrouter'])

export function desktopProviderAllowed(provider: string, id?: string) {
    return API_PROVIDERS.has(provider) || (provider === 'custom' && registeredCustomConnectionIdSchema.safeParse(id).success) || (provider === 'codex' && id === DESKTOP_CODEX_ID && desktopCodexAvailable())
        || (provider === 'claude' && id === DESKTOP_CLAUDE_CONNECTION_ID && desktopClaudeAvailable())
}

export function assertDesktopProvider(provider: string, id?: string): void {
    if (desktopApp() && !desktopProviderAllowed(provider, id)) throw badRequest('This connection is unavailable in the desktop preview.')
}

export function desktopRouteAllowed(method: string, path: string): boolean {
    // Named API changes require F's revision/receipt authority, including on
    // case-insensitive filesystems. Encoded aliases also fail the strict id below.
    if ((method === 'PATCH' || method === 'DELETE') && /^\/connections\/cnx_/i.test(path)) return false
    if (/^\/desktop\/api-connections\/(?:catalog|removal)$/.test(path)) return method === 'GET'
    if (/^\/desktop\/api-connections\/(?:create|rename|models|credential|remove)$/.test(path)) return method === 'POST'
    // Named default selection still lacks its root authorizer and stays closed.
    if (path === '/desktop/foreman/file-permissions') return method === 'GET' || method === 'PATCH'
    if (path === '/desktop/external-mcp/keys') return method === 'GET' || method === 'POST'
    if (path === '/desktop/external-mcp/listener') return method === 'GET'
    if (/^\/desktop\/external-mcp\/(?:keys\/revoke|listener\/enable|listener\/disable|recheck)$/.test(path)) return method === 'POST'
    if (path === '/desktop/custom-providers') return method === 'POST'
    if (path === '/desktop/workspace-admission') return method === 'POST'
    if (/^\/desktop\/workspace-routines\/[A-Za-z0-9_-]+$/.test(path)) return method === 'GET' || method === 'POST'
    if (/^\/desktop\/brain\/semantic\/[A-Za-z0-9_-]+\/status$/.test(path)) return method === 'GET'
    if (/^\/desktop\/brain\/semantic\/[A-Za-z0-9_-]+\/(?:search|index)$/.test(path)) return method === 'POST'
    if (path === '/desktop/company-brief') return method === 'GET'
    if (/^\/desktop\/company-brief\/(?:observe|synthesize|cancel|cancel-chat|edit|dismiss|retry|handoff|handoff-receipt)$/.test(path)) return method === 'POST'
    if (method === 'GET' && /^\/agents\/[^/]+\/setup\/?$/.test(path)) return true
    if (method === 'POST' && /^\/agents\/[^/]+\/setup\/(save|claim|continue|import)$/.test(path)) return true
    if (desktopTemplateRouteAllowed(method, path)) return true
    if (desktopBrainPagesRouteAllowed(method, path)) return true
    if (/^\/desktop\/brain\/proposals(?:\/count)?$/.test(path)) return method === 'GET'
    if (/^\/desktop\/brain\/proposals\/[A-Za-z0-9_-]+\/(?:accept|dismiss)$/.test(path)) return method === 'POST'
    if (path === '/desktop/foreman/chat' || path === '/desktop/agents/foreman-create') return method === 'POST'
    if (/^\/desktop\/agents\/foreman-create\/[A-Za-z0-9_-]+$/.test(path)) return method === 'GET'
    if (/^\/desktop\/templates\/foreman-import\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(path)) return method === 'GET'
    // Delegation and coworker calls read Foreman's current grants from its engine details.
    if (path === '/agents/foreman') return method === 'GET'
    // Only the private Foreman chat adapter may admit runs. Its observer reads these exact routes.
    if (/^\/agents\/foreman\/(?:sessions\/[A-Za-z0-9_-]+(?:\/messages)?|runs\/[A-Za-z0-9_-]+(?:\/stream)?)$/.test(path)) return method === 'GET'
    if (/^\/agents\/foreman\/runs\/[A-Za-z0-9_-]+\/cancel$/.test(path)) return method === 'POST'
    if (path === '/desktop/computer-panel/control') return method === 'POST'
    if (path === '/desktop/tool-install/control') return method === 'POST'
    if (path === '/desktop/delegation/stop') return method === 'POST'
    if (path === '/desktop/triggers/manage') return method === 'POST'
    if (path === '/desktop/agents/create') return method === 'POST'
    if (path === '/desktop/new-agent/read') return method === 'POST'
    if (path === '/desktop/codex-login') return (method === 'GET' || method === 'POST') && desktopCodexAvailable()
    if (path === '/desktop/claude-login') return (method === 'GET' || method === 'POST') && desktopClaudeAvailable()
    if (/^\/agents\/(?:import|foreman|default)(?:\/|$)/.test(path)) return false
    const id = '[A-Za-z0-9_-]+'
    if (new RegExp(`^/agents/${id}/sessions/${id}/mcp-sign-in-source$`).test(path)) return method === 'POST'
    if (new RegExp(`^/agents/${id}/sessions/${id}/secret-request-source$`).test(path)) return method === 'POST'
    if (new RegExp(`^/agents/${id}/memories/semantic/status$`).test(path)) return method === 'GET'
    if (new RegExp(`^/agents/${id}/memories/semantic/(?:recall|index)$`).test(path)) return method === 'POST'
    if (new RegExp(`^/agents/${id}/screen/status$`).test(path)) return method === 'GET'
    if (new RegExp(`^/agents/${id}/screen/(?:view|takeover|takeover/finish|stop)$`).test(path)) return method === 'POST'
    // Human review uses the authenticated proposal API. Skill file management still goes
    // through the confined desktop publisher; do not open the hosted /skills endpoints.
    const proposals = `/agents/${id}/skill-proposals`
    if (new RegExp(`^${proposals}$`).test(path)) return method === 'GET'
    if (new RegExp(`^${proposals}/${id}/(?:accept|dismiss)$`).test(path)) return method === 'POST'
    const schedules = `/agents/${id}/schedules`
    if (new RegExp(`^${schedules}$`).test(path)) return method === 'GET' || method === 'POST'
    if (new RegExp(`^${schedules}/${id}$`).test(path)) return method === 'GET' || method === 'PATCH' || method === 'DELETE'
    if (new RegExp(`^${schedules}/${id}/run$`).test(path)) return method === 'POST'
    const data = `/(?:agents/${id}/data|shared/data)/tables`
    const item = '[^/]+'
    if (new RegExp(`^${data}$`).test(path)) return method === 'GET'
    if (new RegExp(`^${data}/${item}$`).test(path)) return method === 'DELETE'
    if (new RegExp(`^${data}/${item}/rows$`).test(path)) return method === 'GET' || method === 'DELETE'
    if (new RegExp(`^${data}/${item}/rows/${item}$`).test(path)) return method === 'PATCH'
    if (new RegExp(`^${data}/${item}/views$`).test(path)) return method === 'GET' || method === 'POST'
    if (new RegExp(`^${data}/${item}/views/${item}$`).test(path)) return method === 'PUT' || method === 'DELETE'
    if (new RegExp(`^${data}/${item}/(?:groups|export)$`).test(path)) return method === 'GET'
    if (new RegExp(`^${data}/${item}/purge$`).test(path)) return method === 'POST'
    if (method === 'GET') return new RegExp(`^/(?:health|agents|connections|agents/${id}(?:/memories|/sessions(?:/${id}(?:/messages)?)?|/runs(?:/completions|/${id}(?:/(?:stream|steps|tools))?)?|/stats)?)$`).test(path)
    if (method === 'POST') return new RegExp(`^/(?:agents|connections|agents/${id}/(?:duplicate|chat|memories(?:/recall)?)|agents/${id}/runs/${id}/cancel)$`).test(path)
    if (method === 'DELETE') return new RegExp(`^/agents/${id}(?:/memories(?:/(?!recall$)${id})?)?$`).test(path)
    if (method === 'PATCH') return new RegExp(`^/(?:agents/${id}|connections/${id}(?:/keys)?)$`).test(path)
    return method === 'PUT' && path === '/connections/default'
}
