import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DesktopApp } from './DesktopApp'

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
})
