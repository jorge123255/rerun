import { expect, it } from 'vitest'
import { desktopCardFilePublication, explicitDesktopCardScope } from './card-file.js'

it('keeps an omitted scope private and never reads a path', () => {
    expect(explicitDesktopCardScope(undefined)).toBe('agent')
    expect(explicitDesktopCardScope('agent')).toBe('agent')
    expect(explicitDesktopCardScope('shared')).toBe('shared')
})

it('publishes every file in order or nothing', () => {
    expect(desktopCardFilePublication([
        { ok: true, file: { path: 'notes/a.txt', scope: 'agent' } },
        { ok: true, file: { path: 'shared/b.zip', scope: 'shared' } },
    ])).toEqual({ ok: true, files: [{ path: 'notes/a.txt', scope: 'agent' }, { path: 'shared/b.zip', scope: 'shared' }] })
    const one = desktopCardFilePublication([
        { ok: true, file: { path: 'notes/a.txt' } },
        { ok: false, message: 'shots/old.png: That file is unavailable in this coworker’s workspace.' },
    ])
    expect(one).toEqual({ ok: false, message: 'Could not show that file, nothing was shown:\nshots/old.png: That file is unavailable in this coworker’s workspace.' })
    if (one.ok) throw new Error('partial card')
    expect(one.message).not.toContain('notes/a.txt')
    const both = desktopCardFilePublication([
        { ok: false, message: 'a: Shared files are not available in a Mac result card.' },
        { ok: false, message: 'b: That file is unavailable in this coworker’s workspace.' },
    ])
    expect(both.ok).toBe(false)
    if (both.ok) return
    expect(both.message.startsWith('Could not show those files, nothing was shown:\n')).toBe(true)
    expect(both.message).toContain('Shared files are not available in a Mac result card.')
})
