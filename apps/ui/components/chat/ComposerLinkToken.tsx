import type { ReactNode } from 'react'
import { LINK_TOKEN_CLASS } from '@/components/chat/composer-token-styles'
import { LinkIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'

export function ComposerLinkToken({ children, title }: { children?: ReactNode; title?: string; node?: unknown }) {
    return (
        <span title={title} className={cn('inline-flex items-baseline gap-[0.3em] font-medium underline-offset-2 [[data-streamdown=link]:hover>&]:underline', LINK_TOKEN_CLASS)}>
            <LinkIcon aria-hidden className="size-[0.85em] shrink-0 self-center" />
            {children}
        </span>
    )
}
