import { badRequest } from '../lib/errors.js'

export const desktopApp = (): boolean => process.env.RERUN_DESKTOP_APP === '1'

const API_PROVIDERS = new Set(['openai', 'anthropic', 'google', 'openrouter'])

export function assertDesktopProvider(provider: string): void {
    if (desktopApp() && !API_PROVIDERS.has(provider)) throw badRequest('This desktop preview supports API providers only. Subscription CLIs are not enabled yet.')
}

export function desktopRouteAllowed(method: string, path: string): boolean {
    if (/^\/agents\/(?:import|foreman|default)(?:\/|$)/.test(path)) return false
    const id = '[A-Za-z0-9_-]+'
    if (method === 'GET') return new RegExp(`^/(?:health|agents|connections|agents/${id}(?:/sessions(?:/${id}(?:/messages)?)?|/runs(?:/${id}/stream)?)?)$`).test(path)
    if (method === 'POST') return new RegExp(`^/(?:agents|connections|agents/${id}/chat|agents/${id}/runs/${id}/cancel)$`).test(path)
    if (method === 'PATCH') return new RegExp(`^/(?:agents/${id}|connections/${id}(?:/keys)?)$`).test(path)
    return method === 'PUT' && path === '/connections/default'
}
