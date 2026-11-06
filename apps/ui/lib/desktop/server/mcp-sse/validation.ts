import { DESKTOP_MCP_SSE_LIMITS as L, desktopMcpSseToolSchema, type DesktopMcpSseTool } from '@rerun/contracts'
import type { RemoteTool } from '../mcp/model'
import { SseFailure } from './errors'
import { z } from 'zod'

export function boundedJson(value: unknown, maxBytes: number) {
    const pending = [{ value, depth: 0 }], seen = new Set<object>()
    let nodes = 0
    while (pending.length) {
        const item = pending.pop()!
        if (++nodes > L.schemaNodes || item.depth > L.schemaDepth) throw new SseFailure('invalid-data')
        if (typeof item.value === 'number' && !Number.isFinite(item.value)) throw new SseFailure('invalid-data')
        if (item.value && typeof item.value === 'object') {
            if (seen.has(item.value)) throw new SseFailure('invalid-data')
            seen.add(item.value)
            for (const [key, child] of Object.entries(item.value)) {
                if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new SseFailure('invalid-data')
                pending.push({ value: child, depth: item.depth + 1 })
            }
        } else if (!['string', 'number', 'boolean'].includes(typeof item.value) && item.value !== null) throw new SseFailure('invalid-data')
    }
    const text = JSON.stringify(value)
    if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) throw new SseFailure('invalid-data')
    return text
}

export function validateSseTools(raw: unknown[], previous: DesktopMcpSseTool[], name: string, normalize: (tool: RemoteTool) => DesktopMcpSseTool) {
    const tools = previous.slice(), names = new Set(previous.map(tool => tool.name))
    for (const value of raw) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SseFailure('invalid-data')
        const t = value as Record<string, unknown>
        if (typeof t.name !== 'string' || !/^[\w.-]{1,128}$/.test(t.name) || t.name.length + name.length + 1 > 128 || names.has(t.name)
            || t.description !== undefined && (typeof t.description !== 'string' || t.description.length > 8000)
            || !t.inputSchema || typeof t.inputSchema !== 'object' || Array.isArray(t.inputSchema)) throw new SseFailure('invalid-data')
        boundedJson(t.inputSchema, L.catalogBytes)
        const checked = desktopMcpSseToolSchema.parse(normalize({ name: t.name, description: t.description as string | undefined, inputSchema: t.inputSchema as Record<string, unknown> }))
        const normalized: DesktopMcpSseTool = { name: checked.name, inputSchema: checked.inputSchema, ...(checked.description !== undefined ? { description: checked.description } : {}) }
        if (normalized.name !== t.name || normalized.inputSchema.type !== 'object') throw new SseFailure('unsupported')
        boundedJson(normalized.inputSchema, L.catalogBytes)
        try { z.fromJSONSchema(normalized.inputSchema as Parameters<typeof z.fromJSONSchema>[0]) } catch { throw new SseFailure('unsupported') }
        names.add(t.name); tools.push(normalized)
        if (tools.length > L.tools) throw new SseFailure('invalid-data')
    }
    boundedJson(tools, L.catalogBytes)
    return tools
}

export function validateSseResult(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SseFailure('invalid-data')
    const result = value as Record<string, unknown>
    boundedJson(result, L.resultBytes)
    if (!Array.isArray(result.content) || result.content.length > 256 || result.content.some(item => {
        if (!item || typeof item !== 'object' || !['text', 'image', 'audio', 'resource', 'resource_link'].includes(item.type)) return true
        if (item.type === 'text') return typeof item.text !== 'string'
        if (item.type === 'image' || item.type === 'audio') return typeof item.data !== 'string' || typeof item.mimeType !== 'string'
        if (item.type === 'resource_link') return typeof item.uri !== 'string' || typeof item.name !== 'string'
        return !item.resource || typeof item.resource !== 'object' || Array.isArray(item.resource) || typeof item.resource.uri !== 'string'
    }) || result.isError !== undefined && typeof result.isError !== 'boolean'
        || result.structuredContent !== undefined && (!result.structuredContent || typeof result.structuredContent !== 'object' || Array.isArray(result.structuredContent))) throw new SseFailure('invalid-data')
    return result
}
