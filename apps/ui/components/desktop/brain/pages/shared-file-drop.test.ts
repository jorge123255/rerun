import { describe, expect, it } from 'vitest'
import { readSharedFileDrag, sharedFileDragData } from '@/components/brain/editor/file-link'
import { acceptedSharedFileDrop, sharedFileDropWorkspace } from './shared-file-link'

const listed = [
    { path: 'readme.md', name: 'readme.md' },
    { path: 'notes/q3.pdf', name: 'q3.pdf' },
    { path: 'notes/..hidden.md', name: '..hidden.md' },
    { path: '100% done.md', name: '100% done.md' },
]

const readme = sharedFileDragData({ path: 'readme.md', name: 'readme.md' }, '1')

describe('sharedFileDragData', () => {
    it('keeps a hosted drag to path and name', () => {
        expect(JSON.parse(sharedFileDragData({ path: 'readme.md', name: 'readme.md' }))).toEqual({ path: 'readme.md', name: 'readme.md' })
    })

    it('adds the desktop workspace', () => {
        expect(JSON.parse(readme)).toEqual({ path: 'readme.md', name: 'readme.md', workspace: '1' })
    })
})

describe('readSharedFileDrag', () => {
    it('reads a file drag and a hosted drag', () => {
        expect(readSharedFileDrag(readme)).toEqual({ path: 'readme.md', name: 'readme.md', workspace: '1' })
        expect(readSharedFileDrag(sharedFileDragData({ path: 'notes/q3.pdf', name: 'q3.pdf' }))).toEqual({ path: 'notes/q3.pdf', name: 'q3.pdf' })
        expect(readSharedFileDrag(JSON.stringify({ path: 'readme.md', name: 'readme.md', type: 'file', workspace: '1' }))).toEqual({ path: 'readme.md', name: 'readme.md', workspace: '1' })
    })

    it.each([
        '{',
        'null',
        '[]',
        '12',
        JSON.stringify({ path: 'readme.md' }),
        JSON.stringify({ path: 1, name: 'readme.md' }),
        JSON.stringify({ path: 'readme.md', name: 'readme.md', workspace: 1 }),
        JSON.stringify({ path: 'readme.md', name: 'readme.md', type: 'dir' }),
        JSON.stringify({ path: 'readme.md', name: 'readme.md', extra: true }),
    ])('refuses %j', raw => {
        expect(readSharedFileDrag(raw)).toBeNull()
    })
})

describe('acceptedSharedFileDrop', () => {
    it('returns the listed file for this workspace', () => {
        expect(acceptedSharedFileDrop(readme, listed, '1')).toEqual({ path: 'readme.md', name: 'readme.md' })
        expect(acceptedSharedFileDrop(sharedFileDragData({ path: 'notes/q3.pdf', name: 'q3.pdf' }, '1'), listed, '1')).toEqual({ path: 'notes/q3.pdf', name: 'q3.pdf' })
        expect(acceptedSharedFileDrop(sharedFileDragData({ path: 'notes/..hidden.md', name: '..hidden.md' }, '1'), listed, '1')).toEqual({ path: 'notes/..hidden.md', name: '..hidden.md' })
        expect(acceptedSharedFileDrop(sharedFileDragData({ path: '100% done.md', name: '100% done.md' }, '1'), listed, '1')).toEqual({ path: '100% done.md', name: '100% done.md' })
    })

    it.each([
        ['forged json', '{'],
        ['array', '[]'],
        ['directory', JSON.stringify({ path: 'notes', name: 'notes', type: 'dir', workspace: '1' })],
        ['extra field', JSON.stringify({ path: 'readme.md', name: 'readme.md', workspace: '1', renamed: true })],
        ['other workspace', sharedFileDragData({ path: 'readme.md', name: 'readme.md' }, '2')],
        ['missing workspace', sharedFileDragData({ path: 'readme.md', name: 'readme.md' })],
        ['wrong name', sharedFileDragData({ path: 'readme.md', name: 'README.md' }, '1')],
        ['unlisted', sharedFileDragData({ path: 'missing.md', name: 'missing.md' }, '1')],
        ['traversal', sharedFileDragData({ path: '../secret.md', name: 'secret.md' }, '1')],
        ['encoded traversal', sharedFileDragData({ path: '%2e%2e/readme.md', name: 'readme.md' }, '1')],
        ['absolute', sharedFileDragData({ path: '/data/agents/other/workspace/readme.md', name: 'readme.md' }, '1')],
    ])('refuses a %s payload', (_label, raw) => {
        expect(acceptedSharedFileDrop(raw, listed, '1')).toBeNull()
    })

    it('refuses every payload when the workspace is not confirmed', () => {
        expect(acceptedSharedFileDrop(readme, listed, '')).toBeNull()
    })
})

describe('sharedFileDropWorkspace', () => {
    it('uses a positive id, and a mount token only while the id is omitted', () => {
        expect(sharedFileDropWorkspace(1, 'mount-a')).toBe('1')
        expect(sharedFileDropWorkspace(undefined, 'mount-a')).toBe('mount-a')
        expect(sharedFileDropWorkspace(null, 'mount-a')).toBeNull()
        expect(sharedFileDropWorkspace(0, 'mount-a')).toBeNull()
        expect(sharedFileDropWorkspace(1.5, 'mount-a')).toBeNull()
        expect(sharedFileDropWorkspace(-1, 'mount-a')).toBeNull()
        expect(sharedFileDropWorkspace(undefined, '')).toBeNull()
    })
})
