import { describe, expect, it } from 'vitest'
import { formatToolName, toolLabelOf } from '@rerun/contracts'

describe('a tool the app has no label for is still named in words', () => {
    it('keeps the names it already read well', () => {
        expect(formatToolName('search_notes')).toBe('Search Notes')
        expect(toolLabelOf('mcp__notes__search_notes')).toBe('Notes Search Notes')
    })

    it('splits a runner’s own camel-case and hyphenated names', () => {
        expect(formatToolName('WebSearch')).toBe('Web Search')
        expect(formatToolName('TodoWrite')).toBe('Todo Write')
        expect(formatToolName('showBarChart')).toBe('Show Bar Chart')
        expect(formatToolName('readPDFFile')).toBe('Read PDF File')
        expect(formatToolName('todo-write')).toBe('Todo Write')
        expect(formatToolName('fs.read_file')).toBe('Fs Read File')
        expect(formatToolName('Bash')).toBe('Bash')
    })

    it('drops the hash a long name was cut and ended with, and only then', () => {
        expect(toolLabelOf('mcp__composio-googlesheets__GOOGLESHEETS_UPDATE_DIMENSI_82883606')).toBe('Composio Googlesheets GOOGLESHEETS UPDATE DIMENSI')
        expect(formatToolName('lookup_deadbeef')).toBe('Lookup Deadbeef')
    })

    it('never shows a name with no words in it', () => {
        for (const name of ['', '___', '42', '--']) expect(formatToolName(name)).toBe('Tool')
    })
})
