import { describe, expect, it } from 'vitest'
import { toToolInputSchema } from '../../tools/mcp-schema.js'
import { modelReadyMcpTool, modelReadyMcpTools } from './model-ready-mcp-tool.js'
import type { McpTool } from '../../tools/mcp.js'

const asTool = (partial: Partial<McpTool> & Pick<McpTool, 'name' | 'inputSchema'>): McpTool => partial as McpTool

describe('modelReadyMcpTool', () => {
    it('lifts a root anyOf and appends the rule without mutating the catalog entry', () => {
        const inputSchema = {
            type: 'object' as const,
            properties: { text: { type: 'string' }, html: { type: 'string' } },
            required: ['to'],
            anyOf: [{ required: ['text'] }, { required: ['html'] }],
        }
        const tool = asTool({ name: 'send_email', description: 'Send', inputSchema })
        const ready = modelReadyMcpTool('email', tool)
        expect(ready).not.toBe(tool)
        expect(tool.inputSchema).toBe(inputSchema)
        expect('anyOf' in tool.inputSchema).toBe(true)
        expect(ready.description).toContain('Provide at least one of: text, html.')
        expect(ready.inputSchema).toEqual({ type: 'object', properties: inputSchema.properties, required: ['to'] })
    })

    it('returns the same object when the schema is already model-ready', () => {
        const inputSchema = { type: 'object' as const, properties: { q: { type: 'string' } }, required: ['q'] }
        const tool = asTool({ name: 'search', description: 'Search', inputSchema })
        expect(modelReadyMcpTool('web', tool)).toBe(tool)
    })

    it('keeps nested property unions and definitions while lifting only the root combinator', () => {
        const inputSchema = {
            type: 'object' as const,
            properties: {
                board_id: { type: 'string' },
                description: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                meta: { $ref: '#/definitions/Meta' },
            },
            required: ['board_id'],
            anyOf: [{ required: ['description'] }],
            definitions: { Meta: { type: 'object', properties: { tag: { type: 'string' } } } },
        }
        const { schema, note } = toToolInputSchema(inputSchema)
        expect(note).toBe('Provide at least one of: description.')
        expect(schema.properties).toMatchObject({ description: inputSchema.properties.description, meta: inputSchema.properties.meta })
        expect(schema.definitions).toEqual(inputSchema.definitions)
        expect('anyOf' in schema).toBe(false)
    })

    it('does not invent tools or broaden optional/required when faced with malformed or oversized roots', () => {
        expect(toToolInputSchema({ type: 'object', oneOf: 'broken' })).toEqual({ schema: { type: 'object' }, note: null })
        expect(toToolInputSchema(undefined)).toEqual({ schema: { type: 'object' }, note: null })
        const hugeProps: Record<string, unknown> = {}
        for (let i = 0; i < 200; i++) hugeProps[`p${i}`] = { type: 'string' }
        const { schema, note } = toToolInputSchema({ type: 'object', properties: hugeProps, oneOf: [{ required: ['p0'] }, { required: ['p1'] }] })
        expect(note).toBe('Provide exactly one of: p0, p1.')
        expect(Object.keys(schema.properties as object)).toHaveLength(200)
        expect('oneOf' in schema).toBe(false)
    })

    it('maps a catalog list without rewriting the caller array identity of unchanged tools', () => {
        const plain = asTool({ name: 'ping', description: 'Ping', inputSchema: { type: 'object' as const, properties: {} } })
        const union = asTool({
            name: 'send',
            description: 'Send',
            inputSchema: { type: 'object' as const, properties: { a: { type: 'string' }, b: { type: 'string' } }, oneOf: [{ required: ['a'] }, { required: ['b'] }] },
        })
        const catalog = [plain, union]
        const ready = modelReadyMcpTools('svc', catalog)
        expect(ready[0]).toBe(plain)
        expect(ready[1]).not.toBe(union)
        expect(catalog[1]).toBe(union)
    })
})
