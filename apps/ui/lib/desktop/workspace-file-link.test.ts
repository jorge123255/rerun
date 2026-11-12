import { expect, test } from 'vitest'
import { desktopWorkspaceFilePath } from './workspace-file-link'

test('uses the first workspace owner and preserves a decoded path within it', () => {
    expect(desktopWorkspaceFilePath('/agents/engine-a/workspace/docs/a%20%23b.md?view=1#L7', 'engine-a')).toBe('docs/a #b.md')
    expect(desktopWorkspaceFilePath('/data/agents/engine-a/workspace/docs/agents/b/workspace/a.md', 'engine-a')).toBe('docs/agents/b/workspace/a.md')
})

test.each([
    undefined,
    'docs/a.md',
    'file:///data/agents/engine-a/workspace/a.md',
    'https://example.invalid/agents/engine-a/workspace/a.md',
    '//server/agents/engine-a/workspace/a.md',
    '/data/agents/b/workspace/agents/engine-a/workspace/a.md',
    '/data/agents/engine-a/workspace/../a.md',
    '/data/agents/engine-a/workspace/%2e%2e/a.md',
    '/data/agents/engine-a/workspace/a%5Cb.md',
    '/data/agents/engine-a/workspace/a%00b.md',
    '/data/agents/engine-a/workspace/a%ZZ.md',
    '/data/agents/engine-a/workspace//a.md',
])('leaves an unrelated or unsafe path inert (%s)', href => {
    expect(desktopWorkspaceFilePath(href, 'engine-a')).toBeNull()
})
