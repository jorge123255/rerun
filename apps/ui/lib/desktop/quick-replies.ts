import { parseQuickReplies, quickRepliesOf } from '@rerun/contracts'

export type DesktopQuickReplyMessage = Parameters<typeof quickRepliesOf>[0]
export type DesktopQuickReplyInput = { replies: string[] }

export function desktopQuickRepliesOf(message: DesktopQuickReplyMessage): string[] {
    return quickRepliesOf(message)
}

export function desktopQuickReplyInputOf(part: unknown): DesktopQuickReplyInput | null {
    if (quickRepliesOf({ role: 'assistant', parts: [part] }).length === 0) return null
    const parsed = parseQuickReplies((part as { input?: unknown }).input)
    return parsed.ok ? { replies: parsed.replies } : null
}
