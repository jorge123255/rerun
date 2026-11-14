import { expect, test } from 'vitest'
import { desktopWorkspaceFileLink } from './workspace-file-link'

test('uses the first workspace owner and preserves a decoded path within it', () => {
    expect(desktopWorkspaceFileLink('/agents/engine-a/workspace/docs/a%20%23b.md?view=1#L7')).toEqual({ owner: 'engine-a', path: 'docs/a #b.md' })
    expect(desktopWorkspaceFileLink('/data/agents/engine-a/workspace/docs/agents/b/workspace/a.md')).toEqual({ owner: 'engine-a', path: 'docs/agents/b/workspace/a.md' })
})

test.each([
    undefined,
    'docs/a.md',
    'file:///data/agents/engine-a/workspace/a.md',
    'https://example.invalid/agents/engine-a/workspace/a.md',
    '//server/agents/engine-a/workspace/a.md',
    '/data/agents/engine-a/workspace/../a.md',
    '/data/agents/engine-a/workspace/%2e%2e/a.md',
    '/data/agents/engine-a/workspace/a%5Cb.md',
    '/data/agents/engine-a/workspace/a%00b.md',
    '/data/agents/engine-a/workspace/a%ZZ.md',
    '/data/agents/engine-a/workspace//a.md',
])('leaves an unrelated or unsafe path inert (%s)', href => {
    expect(desktopWorkspaceFileLink(href)).toBeNull()
})
