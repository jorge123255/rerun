import { describe, expect, it } from 'vitest'
import { authorizedSharedFilePath, linkableSharedFiles } from './shared-file-link'

const listed = [
    { path: 'readme.md', name: 'readme.md' },
    { path: 'notes/q3.pdf', name: 'q3.pdf' },
    { path: 'notes/..hidden.md', name: '..hidden.md' },
    { path: '100% done.md', name: '100% done.md' },
]

describe('authorizedSharedFilePath', () => {
    it('returns a listed relative path unchanged', () => {
        expect(authorizedSharedFilePath('readme.md', listed)).toBe('readme.md')
        expect(authorizedSharedFilePath('notes/q3.pdf', listed)).toBe('notes/q3.pdf')
        expect(authorizedSharedFilePath('notes/..hidden.md', listed)).toBe('notes/..hidden.md')
        expect(authorizedSharedFilePath('100% done.md', listed)).toBe('100% done.md')
    })

    it.each([
        '',
        '../secret.md',
        'notes/../../secret.md',
        './readme.md',
        'notes//q3.pdf',
        '/data/shared/readme.md',
        '/data/agents/other/workspace/readme.md',
        'C:/readme.md',
        '\\\\server\\share\\readme.md',
        'file:///etc/passwd',
        'https://example.com/readme.md',
        'shared:readme.md',
        'missing.md',
        'readme.md?download=1',
        '%2e%2e/readme.md',
        '%2e%2e%2freadme.md',
        'notes%2F..%2Fsecret.md',
        ' readme.md',
        'readme.md ',
        'notes/ ../q3.pdf',
    ])('rejects %j', path => {
        expect(authorizedSharedFilePath(path, listed)).toBeNull()
    })

    it('rejects a null byte and an overlong path', () => {
        expect(authorizedSharedFilePath('readme.md\0', listed)).toBeNull()
        expect(authorizedSharedFilePath(`${'a'.repeat(4097)}`, listed)).toBeNull()
    })

    it('does not treat another workspace absolute path as the listed file with the same name', () => {
        expect(authorizedSharedFilePath('/data/shared/readme.md', listed)).toBeNull()
        expect(authorizedSharedFilePath('/data/agents/other/workspace/readme.md', [{ path: 'readme.md', name: 'readme.md' }])).toBeNull()
    })
})

describe('linkableSharedFiles', () => {
    it('drops listings the opener would refuse', () => {
        expect(linkableSharedFiles([
            ...listed,
            { path: '../secret.md', name: 'secret.md' },
            { path: '/data/agents/other/workspace/notes.md', name: 'notes.md' },
        ])).toEqual(listed)
    })
})
