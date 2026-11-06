'use client'

import { useState } from 'react'
import { McpClientPicker } from '@/components/dialogs/McpClientPicker'
import { DocsLink } from '@/components/ui/docs-link'
import { Field } from '@/components/ui/field'
import { mcpClientDocs, type McpClientId } from '@/lib/mcp/connect'
import { EXTERNAL_MCP_KEY_PLACEHOLDER, externalMcpClientSnippets } from '@/lib/desktop/external-mcp/snippets'
import { Stripes } from '@rerun/ui/primitives'
import { DesktopExternalMcpCopyBlock, DesktopExternalMcpCopyLine } from './DesktopExternalMcpCopy'

export function DesktopExternalMcpSnippets({ mcpUrl, apiKey = EXTERNAL_MCP_KEY_PLACEHOLDER, writeText }: { mcpUrl: string; apiKey?: string; writeText?: (value: string) => void | Promise<void> }) {
    const [client, setClient] = useState<McpClientId>('claude-code')
    return (
        <div className="min-w-0 overflow-hidden rounded-lg border border-border/60 bg-muted/20">
            <div className="relative overflow-hidden border-b border-border/60 bg-muted/30 px-3 py-2.5">
                <Stripes />
                <McpClientPicker value={client} onChange={setClient} className="relative" />
            </div>
            <div className="space-y-2.5 p-3">
                {externalMcpClientSnippets(client, mcpUrl, apiKey).map(snippet => (
                    <Field key={snippet.label} label={snippet.label} helperText={snippet.hint}>
                        {snippet.block
                            ? <DesktopExternalMcpCopyBlock value={snippet.value} label={`Copy ${snippet.label}`} writeText={writeText} />
                            : <DesktopExternalMcpCopyLine value={snippet.value} label={`Copy ${snippet.label}`} writeText={writeText} />}
                    </Field>
                ))}
                <DocsLink path={mcpClientDocs(client)}>Full setup guide</DocsLink>
            </div>
        </div>
    )
}
