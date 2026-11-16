import { expect, test } from 'vitest'
import { buildDesktopConnectorApps, desktopBundledLogo, desktopReplyMayUseConnector, desktopConnectorIconProps, NO_CONNECTOR_APPS, resolveDesktopConnectorTool } from './connector-apps'

const apps = buildDesktopConnectorApps({
    agentId: 'agent',
    servers: [
        { server: 'linear', slug: 'linear', name: 'Linear', label: 'Work', icon: '/services/linear.svg', category: 'productivity' },
        { server: 'my-tools', slug: 'mcp:my-tools', name: 'my-tools', icon: null, category: 'custom', custom: true },
        { server: 'composio', slug: 'composio', name: 'Composio', icon: null, category: 'other' },
        { server: 'memory', slug: 'memory-app', name: 'Memory', icon: 'https://elsewhere.example/logo.png', category: 'other' },
    ],
    toolkits: [
        { key: 'gmail', slug: 'gmail', name: 'Gmail', label: 'Personal', icon: '/services/gmail.png?tone=light', category: 'productivity' },
        { key: 'googleanalytics', slug: 'google-analytics', name: 'Google Analytics', icon: '/services/google-analytics.png', category: 'analytics' },
        { key: 'acme', slug: 'acme', name: 'Acme', icon: null, category: 'other' },
    ],
})

test('a tool of a named app wears the app and drops the server from its words', () => {
    const native = resolveDesktopConnectorTool('linear_create_issue', apps)
    expect(native).toMatchObject({ label: 'Create Issue', service: { slug: 'linear', label: 'Work', icon: '/services/linear.svg' } })
    expect(resolveDesktopConnectorTool('mcp__linear__create_issue', apps)?.label).toBe('Create Issue')
    expect(desktopConnectorIconProps(native!.service)).toEqual({ src: '/services/linear.svg' })
})

test('a server outside the catalog keeps its name and the plain connector mark', () => {
    const custom = resolveDesktopConnectorTool('my-tools_do_thing', apps)
    expect(custom?.label).toBe('my-tools · Do Thing')
    expect(desktopConnectorIconProps(custom!.service)).toHaveProperty('icon')
})

test('a managed app tool is found by its toolkit, longest name first', () => {
    expect(resolveDesktopConnectorTool('GMAIL_SEND_EMAIL', apps)).toMatchObject({ label: 'Send Email', service: { name: 'Gmail', label: 'Personal' } })
    expect(resolveDesktopConnectorTool('GOOGLE_ANALYTICS_RUN_REPORT', apps)).toMatchObject({ label: 'Run Report', service: { slug: 'google-analytics' } })
    // No logo to carry the app: its name stays in the words.
    expect(resolveDesktopConnectorTool('ACME_DO_THING', apps)?.label).toBe('Acme Do Thing')
})

test('a Composio step that ran other tools is named after them and wears the first app', () => {
    const input = { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: {} }, { tool_slug: 'NOTION_SEARCH', arguments: {} }] }
    for (const name of ['composio_COMPOSIO_MULTI_EXECUTE_TOOL', 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL']) {
        expect(resolveDesktopConnectorTool(name, apps, input)).toMatchObject({ label: 'Gmail Send Email +1', service: { slug: 'gmail' } })
    }
    // An inner app this Mac has no entry for keeps the connector itself; another Composio tool reads calmly.
    expect(resolveDesktopConnectorTool('composio_COMPOSIO_MULTI_EXECUTE_TOOL', apps, { tools: [{ tool_slug: 'NOTION_SEARCH' }] })).toMatchObject({ label: 'Notion Search', service: { slug: 'composio' } })
    expect(resolveDesktopConnectorTool('composio_COMPOSIO_SEARCH_TOOLS', apps)?.label).toBe('Composio Search Tools')
})

test('anything that belongs to no app resolves to nothing', () => {
    for (const name of ['web_search', 'fs_read', 'memory_write', 'functions.exec', 'SLACK_SEND_MESSAGE', 'unknown_tool', 'Gmail_Send']) {
        expect(resolveDesktopConnectorTool(name, apps), name).toBeNull()
    }
    expect(resolveDesktopConnectorTool('GMAIL_SEND_EMAIL', NO_CONNECTOR_APPS)).toBeNull()
    expect(resolveDesktopConnectorTool('linear_create_issue', NO_CONNECTOR_APPS)).toBeNull()
})

test('only artwork the app ships is ever drawn', () => {
    expect(desktopBundledLogo('/services/gmail.png?tone=dark')).toBe('/services/gmail.png?tone=dark')
    for (const icon of ['https://logos.composio.dev/api/gmail', '//evil.example/x.png', '/services/../secret.png', '/api/desktop/x.png', 'stripe', '', null, undefined]) {
        expect(desktopBundledLogo(icon), String(icon)).toBeNull()
    }
    // A remote picture in a listing is dropped when the map is built, so the row falls back to a glyph.
    const remote = resolveDesktopConnectorTool('memory_lookup', apps)
    expect(remote?.service.icon).toBeNull()
    expect(desktopConnectorIconProps(remote!.service)).toHaveProperty('icon')
})

test('only a reply holding a step outside Rerun’s own tools asks for the coworker’s apps', () => {
    expect(desktopReplyMayUseConnector([{ type: 'text' }, { type: 'tool-fs_read' }, { type: 'tool-mcp__rerun__web_search' }, { type: 'dynamic-tool', toolName: 'memory_write' }, { type: 'data-compaction' }, { type: 'tool-image_generation' }, { type: 'dynamic-tool', toolName: 'exec' }])).toBe(false)
    expect(desktopReplyMayUseConnector([{ type: 'text' }, { type: 'dynamic-tool', toolName: 'linear_create_issue' }])).toBe(true)
    expect(desktopReplyMayUseConnector([{ type: 'tool-GMAIL_SEND_EMAIL' }])).toBe(true)
})
