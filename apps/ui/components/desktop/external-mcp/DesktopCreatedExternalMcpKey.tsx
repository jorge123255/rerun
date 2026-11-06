'use client'

import { useState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { CircleCheckIcon } from '@/lib/icons'
import { EXTERNAL_MCP_COPY } from '@rerun/contracts'
import { EXTERNAL_MCP_KEY_PLACEHOLDER } from '@/lib/desktop/external-mcp/snippets'
import { DesktopExternalMcpCopyLine } from './DesktopExternalMcpCopy'
import { DesktopExternalMcpSnippets } from './DesktopExternalMcpSnippets'

export function DesktopCreatedExternalMcpKey({ value, mcpUrl, onDismiss, writeText }: { value: string; mcpUrl: string | null; onDismiss: () => void; writeText?: (value: string) => void | Promise<void> }) {
    const [revealed, setRevealed] = useState(true)
    return (
        <Alert variant="success" className="min-w-0 gap-3 p-3">
            <p className="flex items-center gap-2 text-sm text-emerald-500">
                <CircleCheckIcon className="size-4 shrink-0" />
                Copy this key now. It will never be shown again.
            </p>
            <DesktopExternalMcpCopyLine value={revealed ? value : 'Key hidden'} copyValue={value} label="Copy the key" writeText={writeText} />
            <div className="flex flex-wrap gap-1">
                <Button type="button" size="sm" variant="ghost" onClick={() => setRevealed(current => !current)}>{revealed ? 'Hide key' : 'Reveal key'}</Button>
                <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>I copied it</Button>
            </div>
            {mcpUrl
                ? <DesktopExternalMcpSnippets mcpUrl={mcpUrl} apiKey={revealed ? value : EXTERNAL_MCP_KEY_PLACEHOLDER} writeText={writeText} />
                : <p className="text-sm text-muted-foreground">{EXTERNAL_MCP_COPY.listenerOff}</p>}
        </Alert>
    )
}
