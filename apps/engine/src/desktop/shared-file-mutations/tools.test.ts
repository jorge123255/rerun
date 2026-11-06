import { expect, test } from 'vitest'
import type { RunContext } from '../../runtime/context.js'
import { desktopSharedMutationTools } from './tools.js'

// Registration only. Execute needs the workspace port, the hub, and a rebuilt contracts package.
// Do not call the tools here.

function context(grants: Record<string, boolean>, shared?: boolean, enabled = true): RunContext {
    return { agent: { id: 'alpha', config: { enabled, tools: { shared, desktopToolGrants: grants } } } } as RunContext
}

test('a read grant registers search and does not register write tools', () => {
    expect(Object.keys(desktopSharedMutationTools(context({ sharedFilesRead: true })))).toEqual(['shared_search'])
    expect(Object.keys(desktopSharedMutationTools(context({ privateFileWrite: true })))).toEqual([])
})

test('a write grant registers create and edit and does not register search', () => {
    expect(Object.keys(desktopSharedMutationTools(context({ sharedFilesWrite: true }))).sort()).toEqual(['shared_edit', 'shared_write'])
})

test('neither grant, a disabled coworker, or tools.shared false registers nothing', () => {
    expect(desktopSharedMutationTools(context({}))).toEqual({})
    expect(desktopSharedMutationTools(context({ sharedFilesRead: true, sharedFilesWrite: true }, true, false))).toEqual({})
    expect(desktopSharedMutationTools(context({ sharedFilesRead: true, sharedFilesWrite: true }, false))).toEqual({})
})

test('both grants register search and the two mutation tools', () => {
    expect(Object.keys(desktopSharedMutationTools(context({ sharedFilesRead: true, sharedFilesWrite: true }))).sort()).toEqual(['shared_edit', 'shared_search', 'shared_write'])
})
