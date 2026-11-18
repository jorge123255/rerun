const item = { type: 'object', properties: { name: { type: 'string' }, action: { type: 'string', enum: ['add', 'list', 'remove'] } }, required: ['name', 'action'] }

export function connectToolList(id: number, form: 'actions' | 'slugs' = 'actions') {
    return Response.json({ jsonrpc: '2.0', id, result: { tools: [
        { name: 'COMPOSIO_MANAGE_CONNECTIONS', inputSchema: {
            type: 'object', properties: { toolkits: { type: 'array', items: form === 'actions' ? { $ref: '#/$defs/ToolkitAction' } : { type: 'string' } } },
            $defs: { ToolkitAction: item },
        } },
        { name: 'COMPOSIO_SEARCH_TOOLS', inputSchema: { type: 'object' } },
    ] } })
}
