import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { loadMessages } from '@rerun/i18n/messages'
import { desktopMessages } from '@/lib/desktop/locale'
import { DesktopApp } from './DesktopApp'
import { DesktopLocale } from './DesktopLocale'

const profile = { id: 1, displayName: 'Local User' }
const workspace = { id: 1, name: 'My workspace' }

describe('DesktopApp', () => {
    it('shows local-first provider setup on a fresh install', () => {
        const html = renderToString(<DesktopApp initialData={{ profile, workspace, agents: [], theme: 'system' as const, default: null, connections: [] }} />)
        expect(html).toContain('Workspace menu, My workspace')
        expect(html).toContain('My workspace')
        expect(html).toContain('Set up provider')
        expect(html).toContain('Create your first coworker')
    })

    it('shows existing coworkers and connected provider state', () => {
        const html = renderToString(<DesktopApp initialData={{
            profile,
            workspace,
            theme: 'system' as const, default: null, connections: [{ id: 'connection-1', name: 'OpenAI', provider: 'openai' as const, models: ['gpt-6-sol'], extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: '' }],
            agents: [{ id: 'local-agent-1', name: 'Researcher', description: 'Finds answers', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
        }} />)
        expect(html).toContain('Researcher')
        expect(html).not.toContain('Set up provider')
        expect(html).toContain('Open model settings')
        expect(html).toContain('Open chat with Researcher')
    })

    it('renders the original workspace pill and board actions together before a coworker opens', () => {
        const html = renderToString(<DesktopApp initialData={{ profile, workspace, agents: [], theme: 'system' as const, default: null, connections: [] }} />)
        expect(html).toContain('aria-label="Team board"')
        expect(html).toContain('aria-label="Workspace"')
        expect(html).toContain('Find chat')
        expect(html).not.toContain('data-side-panel')
    })

    it('localizes the setup and connected provider states without translating provider or model names', async () => {
        const language = { preference: 'fr', locale: 'fr', messages: desktopMessages('fr', await loadMessages('fr')) } as const
        const initial = { profile, workspace, agents: [], theme: 'system' as const, default: null, connections: [] }
        const render = (connections: Parameters<typeof DesktopApp>[0]['initialData']['connections']) => renderToString(
            <DesktopLocale initial={language}><DesktopApp initialData={{ ...initial, connections }} /></DesktopLocale>,
        )
        expect(render([])).toContain('Configurer un fournisseur')
        const html = render([{ id: 'openai', name: 'OpenAI', provider: 'openai', models: ['gpt-6-sol'], extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: '' }])
        expect(html).toContain('OpenAI est connecté')
        expect(html).toContain('Ouvrir les paramètres des modèles')
        expect(html).not.toContain('Set up provider')
    })
})
