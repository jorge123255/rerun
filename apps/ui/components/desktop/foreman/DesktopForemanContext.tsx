'use client'

import { Context } from '@/components/ai-elements/context'
import type { DesktopModelView } from '@/lib/desktop/chat-model'
import type { DesktopForemanClientState } from '@/lib/desktop/foreman-client/runtime-client'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { useDesktopLocale } from '../DesktopLocale'

export function DesktopForemanContext({ context, effective }: {
    context: DesktopForemanClientState['context']
    effective: DesktopModelView['effective']
}) {
    const { language, t } = useDesktopLocale()
    if (!context || !effective.available || effective.connectionId !== context.model.connectionId || effective.model !== context.model.model) return null
    const title = t(context.estimated ? 'foreman.contextEstimate' : 'foreman.context.title')
    return <Context usedTokens={context.usedTokens} maxTokens={context.maxTokens} usage={context.usage} locale={desktopLocaleTag(language.locale)}
        labels={{ ...language.messages.foreman.context, title,
            usedLabel: percent => context.estimated ? `${title} · ${percent}%` : t('foreman.context.usedLabel', { percent }) }} />
}
