import { messageDayLabel, messageTime } from '@rerun/i18n/format'

export function ChatTimeSeparator({ createdAt, locale }: { createdAt: string; locale?: string }) {
    return (
        <time dateTime={createdAt} className="block text-center text-muted-foreground text-xs">
            <span className="font-medium">{messageDayLabel(createdAt, locale)}</span> {messageTime(createdAt, locale)}
        </time>
    )
}
