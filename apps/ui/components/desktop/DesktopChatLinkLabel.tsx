import type { ReactNode } from 'react'
import { ComposerLinkToken } from '@/components/chat/ComposerLinkToken'

// Match the desktop shell's external URL admission without expanding it.
export function safeDesktopChatLink(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 4096 || !/^https:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return false
    try {
        const url = new URL(value)
        return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password
    } catch { return false }
}

export function DesktopChatLinkLabel({ children, title }: { children?: ReactNode; title?: string; node?: unknown }) {
    return <span data-chat-find-url={title}><ComposerLinkToken title={title}>{children}</ComposerLinkToken></span>
}
