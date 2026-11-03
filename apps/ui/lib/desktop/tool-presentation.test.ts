import { describe, expect, it } from 'vitest'
import { desktopToolPresentation as show } from './tool-presentation'
import { desktopRunDetailsView } from './run-details'

describe('public tool activity', () => {
    it('selects bounded native terminal output and exit code from the real SDK envelope, live and restored', () => {
        const item = { type: 'commandExecution', command: 'printf test', cwd: '/private/profile', commandActions: [{ private: 'private-actions' }],
            status: 'completed', exitCode: 0, aggregatedOutput: 'ok\nTOKEN=abc123\nAuthorization: Bearer hidden\n'.repeat(100), _meta: { cookie: 'private-cookie' } }
        const live = show('exec', { ...item, aggregatedOutput: null }, item)
        expect(live).toEqual(show('exec', { ...item, aggregatedOutput: null }, { type: 'json', value: item }))
        expect(live.input?.preview).toBe('printf test')
        expect(live.output).toContain('Exit code 0\nok')
        expect(live.output!.length).toBeLessThan(2050)
        expect(JSON.stringify(live)).not.toMatch(/abc123|hidden|private-actions|private-cookie|private\/profile/)
        expect(show('exec', undefined, { ...item, exitCode: 1, status: 'failed' }).errorText).toBe('Exit code 1')
    })

    it('projects native edits, connector text and errors without arbitrary protocol or rich content', () => {
        const edit = { type: 'fileChange', status: 'completed', changes: [{ path: 'notes.md', kind: { type: 'update' }, diff: 'PRIVATE PATCH BODY' }] }
        expect(show('patch', edit, edit)).toEqual({ input: { preview: 'update · notes.md' }, output: 'update · notes.md' })
        const connector = { content: [{ type: 'text', text: '<img src=x>' }, { type: 'image', data: 'private-blob' }], _meta: 'private-meta' }
        expect(show('mcp__calendar__find', { token: 'private-token' }, connector)).toEqual({ output: '<img src=x>' })
        expect(show('request_secret', { secret: 'private' }, { type: 'text', value: 'private' })).toEqual({})
        expect(show('some_tool', { headers: { authorization: 'private' } }, { internal: 'private' })).toEqual({})
        expect(show('fs_read', undefined, { type: 'error-json', value: { message: 'Unavailable', private: true } })).toEqual({ errorText: 'Unavailable' })
        expect(show('mcp__other__fs_read', {}, 'PRIVATE')).toEqual({})
        expect(show('functions.exec', { code: '1 + 1', private: 'hidden' }, { type: 'text', value: '2' })).toEqual({ input: { preview: '1 + 1' }, output: '2' })
    })

    it('uses the same public result in owner-scoped Run Details', () => {
        const tool = { id: 't', toolName: 'exec', stepNumber: 1, isError: 0, durationMs: 5,
            resultJson: JSON.stringify({ type: 'commandExecution', aggregatedOutput: 'wrote sample', exitCode: 0, secret: 'private-value' }) }
        const row = desktopRunDetailsView([], [tool]).tools[0]
        expect(JSON.parse(row.resultJson!)).toBe('Exit code 0\nwrote sample')
        expect(JSON.stringify(row)).not.toContain('private-value')
    })
})
