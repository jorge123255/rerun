import { expect, it, vi } from 'vitest'
vi.mock('@/hooks/useToolDisplay', () => ({}))
import { desktopToolStepDisplay } from './DesktopToolStep'

it('names a Composio multi-execute step after the tool it ran', () => {
    const input = { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: {} }, { tool_slug: 'SLACK_SEND_MESSAGE', arguments: {} }] }
    expect(desktopToolStepDisplay('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', input).label).toBe('Gmail Send Email +1')
    expect(desktopToolStepDisplay('composio_COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'NOTION_SEARCH', arguments: {} }] }).label).toBe('Notion Search')
})

it('leaves every other step as it was', () => {
    expect(desktopToolStepDisplay('functions.exec', { name: 'GMAIL_SEND_EMAIL' }).label).toBe('Code mode')
    expect(desktopToolStepDisplay('web_search', { query: 'x' }).label).toBe(desktopToolStepDisplay('web_search').label)
})
