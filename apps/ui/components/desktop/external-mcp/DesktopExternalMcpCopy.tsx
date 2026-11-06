'use client'

import { Button } from '@/components/ui/button'
import { CheckIcon, CopyIcon } from '@/lib/icons'
import { copyDesktopExternalMcpText } from '@/lib/desktop/external-mcp/copy'
import { useCopy } from '@/lib/use-copy'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

const copyFailed = () => toast.error('Could not copy. Select the text and copy it yourself.')
type CopyProps = { value: string; label: string; className?: string; copyValue?: string; writeText?: (value: string) => void | Promise<void> }

export function DesktopExternalMcpCopyLine({ value, label, className, copyValue, writeText = copyDesktopExternalMcpText }: CopyProps) {
    const { copied, copy } = useCopy(copyFailed, writeText)
    return (
        <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
            <code className="no-scrollbar block h-8 min-w-0 flex-1 overflow-x-auto rounded-md border border-input bg-muted/40 px-3 font-mono text-xs leading-8 whitespace-nowrap">{value}</code>
            <Button type="button" size="icon-sm" variant="outline" aria-label={label} onClick={() => copy(copyValue ?? value)}>
                {copied ? <CheckIcon className="size-3.5 text-emerald-500" /> : <CopyIcon className="size-3.5" />}
            </Button>
        </div>
    )
}

export function DesktopExternalMcpCopyBlock({ value, label, className, writeText = copyDesktopExternalMcpText }: CopyProps) {
    const { copied, copy } = useCopy(copyFailed, writeText)
    return (
        <div className={cn('relative min-w-0 rounded-md border border-input bg-muted/40', className)}>
            <pre className="no-scrollbar overflow-x-auto py-2.5 pr-11 pl-3 font-mono text-xs leading-5 whitespace-pre">{value}</pre>
            <Button type="button" size="icon-sm" variant="ghost" aria-label={label} onClick={() => copy(value)} className="absolute top-1.5 right-1.5">
                {copied ? <CheckIcon className="size-3.5 text-emerald-500" /> : <CopyIcon className="size-3.5" />}
            </Button>
        </div>
    )
}
