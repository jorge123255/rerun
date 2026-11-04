import { DESKTOP_CODEX_ID, desktopCodexAvailable } from './codex-runtime.js'
import { badRequest } from '../lib/errors.js'

export const desktopApp = (): boolean => process.env.RERUN_DESKTOP_APP === '1'

const API_PROVIDERS = new Set(['openai', 'anthropic', 'google', 'openrouter'])

export function desktopProviderAllowed(provider: string, id?: string) {
    return API_PROVIDERS.has(provider) || (provider === 'codex' && id === DESKTOP_CODEX_ID && desktopCodexAvailable())
}

export function assertDesktopProvider(provider: string, id?: string): void {
    if (desktopApp() && !desktopProviderAllowed(provider, id)) throw badRequest('This connection is unavailable in the desktop preview.')
}

export function desktopRouteAllowed(method: string, path: string): boolean {
    if (path === '/desktop/codex-login') return (method === 'GET' || method === 'POST') && desktopCodexAvailable()
    if (/^\/agents\/(?:import|foreman|default)(?:\/|$)/.test(path)) return false
    const id = '[A-Za-z0-9_-]+'
    if (method === 'GET') return new RegExp(`^/(?:health|agents|connections|agents/${id}(?:/memories|/sessions(?:/${id}(?:/messages)?)?|/runs(?:/${id}/(?:stream|steps|tools))?|/stats)?)$`).test(path)
    if (method === 'POST') return new RegExp(`^/(?:agents|connections|agents/${id}/(?:duplicate|chat|memories(?:/recall)?)|agents/${id}/runs/${id}/cancel)$`).test(path)
    if (method === 'DELETE') return new RegExp(`^/agents/${id}(?:/memories(?:/(?!recall$)${id})?)?$`).test(path)
    if (method === 'PATCH') return new RegExp(`^/(?:agents/${id}|connections/${id}(?:/keys)?)$`).test(path)
    return method === 'PUT' && path === '/connections/default'
}
