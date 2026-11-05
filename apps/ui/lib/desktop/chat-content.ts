import { desktopAttachmentSelectionsOf, type DesktopAttachmentFields } from '@rerun/contracts'

type SendContent = DesktopAttachmentFields & { text: string }

/** Called after attachment schemas validate the selected identities. Never invent user prose. */
export function desktopChatHasContent(input: SendContent): boolean {
    return !!input.text.trim() || desktopAttachmentSelectionsOf(input).length > 0
}

/** A file-only first turn still needs a useful, stable title, including lost-response recovery. */
export function desktopChatTitle(input: SendContent): string {
    const files = desktopAttachmentSelectionsOf(input).map(item => typeof item === 'string' ? item.split('/').pop()! : item.name)
    return (input.text.trim() || files.join(', ') || 'New conversation').slice(0, 80)
}
