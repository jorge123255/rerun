'use client'

import { NoticeActions, type NoticeAction } from '@/components/chat/NoticeActions'
import { Icon } from '@/components/ui/icon'
import { ProviderIcon } from '@/lib/engine/provider-icons'
import { BorderBeam } from '@rerun/ui'
import { AlertTriangleIcon, ClockIcon, GaugeIcon, MessageSquareIcon, PlugIcon, RotateCwIcon, ScrollTextIcon, ServerIcon, SquareIcon, UnplugIcon } from '@/lib/icons'
import { MessageSquarePlus } from 'lucide-react'
import { chatErrorTitle, describeSubscriptionLimit, friendlyError, isAnthropicKeyNotScoped, type ChatErrorKind } from '@/lib/chat-error'
import type { ComponentType } from 'react'

type NoticeKind = ChatErrorKind

const ClaudeGlyph = ({ className }: { className?: string }) => <ProviderIcon provider="claude" className={className} />
const AnthropicGlyph = ({ className }: { className?: string }) => <ProviderIcon provider="anthropic" className={className} />
const OpenAIGlyph = ({ className }: { className?: string }) => <ProviderIcon provider="openai" className={className} />
const OpencodeGlyph = ({ className }: { className?: string }) => <ProviderIcon provider="opencode" className={className} />

const ICONS: Record<NoticeKind, ComponentType<{ className?: string }>> = {
    budget: GaugeIcon,
    usage_limit: GaugeIcon,
    unauthorized: UnplugIcon,
    overloaded: ServerIcon,
    context_window: ScrollTextIcon,
    provider_error: ServerIcon,
    thinking_replay: RotateCwIcon,
    interrupted: RotateCwIcon,
    run_in_flight: RotateCwIcon,
    session_gone: MessageSquareIcon,
    generic: AlertTriangleIcon,
}

function header(kind: NoticeKind, message: string): { title: string; icon: ComponentType<{ className?: string }> } {
    const title = chatErrorTitle(kind, message) ?? 'Something went wrong'
    if (kind !== 'usage_limit') return { title, icon: ICONS[kind] }
    const plan = describeSubscriptionLimit(message).plan
    if (!plan) return { title, icon: ICONS.usage_limit }
    return { title, icon: plan === 'claude' ? ClaudeGlyph : plan === 'anthropic' ? AnthropicGlyph : plan === 'opencode' ? OpencodeGlyph : OpenAIGlyph }
}

/**
 * What a plan that ran out lets the person do besides switching model: wait for it. `plan` is the
 * plan the conversation is waiting for and when it resets; `queued` is true once the message is
 * already set to be sent then.
 */
export type DesktopUsageWaitOffer = { plan: { name: string; resetsAt: string | null } | null; queued: boolean; busy?: boolean; error?: string; onSendAtReset?: () => void }

export function usageResetLine(plan: { name: string; resetsAt: string | null }): string {
    if (!plan.resetsAt) return `${plan.name} has not said when it resets. Rerun checks every 15 minutes, for up to 24 hours.`
    const time = new Date(plan.resetsAt)
    return `${plan.name} resets at ${Number.isNaN(time.getTime()) ? plan.resetsAt : time.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`
}

export function DesktopProviderErrorNotice({ kind, message, onRetry, onContinue, onStopRun, onNewConversation, onReconnect, onSwitchModel, usage }: {
    usage?: DesktopUsageWaitOffer
    kind: NoticeKind
    message: string
    onRetry?: () => void
    onContinue?: () => void
    onStopRun?: () => void
    onNewConversation?: () => void
    onReconnect?: () => void
    onSwitchModel?: () => void
}) {
    const { title, icon } = header(kind, message)

    const actions: NoticeAction[] = []
    if (kind === 'run_in_flight' && onStopRun) {
        actions.push({
            key: 'stop',
            leading: <Icon icon={SquareIcon} size="sm" />,
            title: 'Stop this run',
            cta: 'Stop run',
            description: 'Frees the conversation for your message.',
            onClick: onStopRun,
        })
    }
    if (kind === 'session_gone' && onNewConversation) {
        actions.push({
            key: 'new-conversation',
            leading: <Icon icon={MessageSquarePlus} size="sm" />,
            title: 'Start a new conversation',
            cta: 'New conversation',
            description: 'Opens a fresh conversation with this coworker.',
            onClick: onNewConversation,
        })
    }
    if (kind === 'interrupted' && onContinue) {
        actions.push({
            key: 'continue',
            leading: <Icon icon={RotateCwIcon} size="sm" />,
            title: 'Continue the run',
            cta: 'Continue',
            description: 'Picks up where the coworker was cut off.',
            onClick: onContinue,
        })
    }
    if ((kind === 'overloaded' || kind === 'generic' || kind === 'thinking_replay') && onRetry) {
        actions.push({
            key: 'retry',
            leading: <Icon icon={RotateCwIcon} size="sm" />,
            title: 'Try again',
            cta: 'Retry',
            description: 'Sends your last message again.',
            onClick: onRetry,
        })
    }
    const waitable = kind === 'usage_limit' && usage?.plan ? usage : null
    if (waitable && !waitable.queued && waitable.onSendAtReset) {
        actions.push({
            key: 'send-at-reset',
            leading: <Icon icon={ClockIcon} size="sm" />,
            title: 'Send when it resets',
            cta: waitable.busy ? 'Queuing…' : 'Send when it resets',
            description: `Keeps this message and sends it once when ${waitable.plan!.name} has usage again. You can cancel it.`,
            onClick: () => { if (!waitable.busy) waitable.onSendAtReset?.() },
        })
    }
    if (onSwitchModel && waitable) {
        actions.push({
            key: 'switch',
            leading: <Icon icon={GaugeIcon} size="sm" />,
            title: 'Choose another model',
            cta: 'Choose another model',
            description: 'Pick another model for this conversation. Nothing moves to a paid key unless you pick it.',
            onClick: onSwitchModel,
        })
    } else if (onSwitchModel && (kind === 'usage_limit' || kind === 'provider_error' || kind === 'context_window' || kind === 'overloaded' || kind === 'generic')) {
        actions.push({
            key: 'switch',
            leading: <Icon icon={GaugeIcon} size="sm" />,
            title: 'Switch to another model',
            cta: 'Switch model',
            description: 'Pick another model for this conversation.',
            onClick: onSwitchModel,
        })
    }
    if (kind === 'unauthorized' && onReconnect) {
        actions.push({
            key: 'reconnect',
            leading: <Icon icon={PlugIcon} size="sm" />,
            title: 'Reconnect',
            cta: 'Reconnect',
            description: isAnthropicKeyNotScoped(kind, message) ? 'Paste the new key on the connection this coworker runs on.' : 'Sign in again on the connection this coworker runs on.',
            onClick: onReconnect,
        })
    }

    return (
        <div role="alert" className="relative mb-2 space-y-2.5 overflow-hidden rounded-lg px-4 pt-3 pb-4">
            <BorderBeam animated pattern="arcs" tone="red" glow width={1} duration={7} />
            <div className="flex items-center gap-2.5 text-sm">
                <Icon size="sm" tone="red" icon={icon} className="bg-red-500/10 text-foreground" />
                <span className="font-medium">{title}</span>
            </div>
            <p className="text-sm">{kind === 'run_in_flight' ? 'A run started earlier is still holding this conversation. Stop it to send your message.' : friendlyError(message)}</p>
            {waitable && <p className="text-sm text-muted-foreground" data-usage-reset>{usageResetLine(waitable.plan!)}{waitable.queued ? ' Your message is set to be sent then.' : ''}</p>}
            {waitable?.error && <p role="alert" className="text-xs text-destructive">{waitable.error}</p>}
            <NoticeActions actions={actions} />
        </div>
    )
}
