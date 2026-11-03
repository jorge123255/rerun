import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DesktopApp } from './DesktopApp'

const profile = { id: 1, displayName: 'Local User' }
const workspace = { id: 1, name: 'My workspace' }

describe('DesktopApp', () => {
    it('shows local-first provider setup on a fresh install', () => {
        const html = renderToString(<DesktopApp initialData={{ profile, workspace, agents: [], connections: [] }} />)
        expect(html).toContain('Rerun Local')
        expect(html).toContain('My workspace')
        expect(html).toContain('OpenAI API key')
        expect(html).toContain('Create your first coworker')
    })

    it('shows existing coworkers and connected provider state', () => {
        const html = renderToString(<DesktopApp initialData={{
            profile,
            workspace,
            connections: [{ id: 'connection-1', provider: 'openai', name: 'OpenAI' }],
            agents: [{ id: 'local-agent-1', name: 'Researcher', description: 'Finds answers', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
        }} />)
        expect(html).toContain('Researcher')
        expect(html).toContain('OpenAI key saved')
        expect(html).toContain('Change API key')
        expect(html).toContain('Select a coworker')
    })

    it('uses a stacked narrow layout with a bounded scrollable coworker area', () => {
        const html = renderToString(<DesktopApp initialData={{ profile, workspace, agents: [], connections: [] }} />)
        expect(html).toContain('md:flex-row')
        expect(html).toContain('md:w-80')
        expect(html).toContain('max-h-[38dvh]')
        expect(html).toContain('sm:flex-row')
    })
})
