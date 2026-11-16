import { expect, it, vi } from 'vitest'
vi.mock('@/hooks/useToolDisplay', () => ({}))
import { desktopToolStepDisplay } from './DesktopToolStep'
import { buildDesktopConnectorApps } from '@/lib/desktop/connector-apps'

it('names a Composio multi-execute step after the tool it ran', () => {
    const input = { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: {} }, { tool_slug: 'SLACK_SEND_MESSAGE', arguments: {} }] }
    expect(desktopToolStepDisplay('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', input).label).toBe('Gmail Send Email +1')
    expect(desktopToolStepDisplay('composio_COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'NOTION_SEARCH', arguments: {} }] }).label).toBe('Notion Search')
})

it('leaves every other step as it was', () => {
    expect(desktopToolStepDisplay('functions.exec', { name: 'GMAIL_SEND_EMAIL' }).label).toBe('Code mode')
    expect(desktopToolStepDisplay('web_search', { query: 'x' }).label).toBe(desktopToolStepDisplay('web_search').label)
})

const connectors = buildDesktopConnectorApps({
    agentId: 'agent',
    servers: [
        { server: 'linear', slug: 'linear', name: 'Linear', icon: '/services/linear.svg', category: 'productivity' },
        { server: 'composio', slug: 'composio', name: 'Composio', icon: null, category: 'other' },
    ],
    toolkits: [{ key: 'gmail', slug: 'gmail', name: 'Gmail', icon: '/services/gmail.png?tone=light', category: 'productivity' }],
})

it('gives a tool of the coworker’s app the app’s logo and a readable name', () => {
    expect(desktopToolStepDisplay('linear_create_issue', { title: 'x' }, connectors)).toMatchObject({ label: 'Create Issue', iconProps: { src: '/services/linear.svg' } })
    expect(desktopToolStepDisplay('GMAIL_SEND_EMAIL', {}, connectors)).toMatchObject({ label: 'Send Email', iconProps: { src: '/services/gmail.png?tone=light' } })
})

it('keeps the name of what a Composio step ran, now under that app’s logo', () => {
    const input = { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: {} }, { tool_slug: 'SLACK_SEND_MESSAGE', arguments: {} }] }
    expect(desktopToolStepDisplay('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', input, connectors)).toMatchObject({ label: 'Gmail Send Email +1', iconProps: { src: '/services/gmail.png?tone=light' } })
})

it('draws a tool that matches no app exactly as it does without the coworker’s apps', () => {
    for (const [name, input] of [['web_search', { query: 'x' }], ['fs_read', { path: 'a.md' }], ['exec', {}], ['functions.exec', {}], ['unknown_server_tool', {}], ['SLACK_SEND_MESSAGE', {}]] as const) {
        expect(desktopToolStepDisplay(name, input, connectors), name).toEqual(desktopToolStepDisplay(name, input))
    }
})
