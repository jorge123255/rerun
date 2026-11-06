import { describe, expect, it } from 'vitest'
import { normalizeSseTool } from './normalize.js'

describe('legacy SSE uses original MCP schema normalization', () => {
    it('retains original required-choice notes and the server_tool naming input', () => {
        const tool = normalizeSseTool({ name: 'choose', inputSchema: { oneOf: [{ required: ['left'] }, { required: ['right'] }] } })
        expect(tool.name).toBe('choose')
        expect(tool.inputSchema.type).toBe('object')
        expect(tool.inputSchema).not.toHaveProperty('oneOf')
        expect(tool.description).toContain('Provide exactly one of: left, right.')
    })
})
