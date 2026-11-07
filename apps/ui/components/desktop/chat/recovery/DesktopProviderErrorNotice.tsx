'use client'

import { NoticeActions, type NoticeAction } from '@/components/chat/NoticeActions'
import { Icon } from '@/components/ui/icon'
import { ProviderIcon } from '@/lib/engine/provider-icons'
import { BorderBeam } from '@rerun/ui'
import { AlertTriangleIcon, GaugeIcon, MessageSquareIcon, PlugIcon, RotateCwIcon, ScrollTextIcon, ServerIcon, SquareIcon, UnplugIcon } from '@/lib/icons'
import { MessageSquarePlus } from 'lucide-react'
import { chatErrorTitle, describeSubscriptionLimit, friendlyError, type ChatErrorKind } from '@/lib/chat-error'
import type { DesktopModelPick } from '@/lib/desktop/chat-model'
import type { ComponentType } from 'react'
import { DesktopRecoveryModelPicker } from './DesktopRecoveryModelPicker'

type NoticeKind = ChatErrorKind

const ClaudeGlyph = ({ className }: { className?: string }) => <ProviderIcon provider="claude" className={className} />
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
    return { title, icon: plan === 'claude' ? ClaudeGlyph : plan === 'opencode' ? OpencodeGlyph : OpenAIGlyph }
}

export function DesktopProviderErrorNotice({ kind, message, agentId, sessionId, onRetry, onContinue, onStopRun, onNewConversation, onReconnect, onSwitchModel, onConversationChoice, onOpenModelSettings, onModelSaved }: {
    kind: NoticeKind
    message: string
    agentId: string
    sessionId: string | null
    onRetry?: () => void
    onContinue?: () => void
    onStopRun?: () => void
    onNewConversation?: () => void
    onReconnect?: () => void
    onSwitchModel?: () => void
    onConversationChoice?: (choice: DesktopModelPick | undefined) => void
    onOpenModelSettings?: () => void
    onModelSaved?: () => void
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
    const wantsSwitch = (kind === 'usage_limit' || kind === 'provider_error' || kind === 'context_window' || kind === 'overloaded' || kind === 'generic') && (onSwitchModel || !!onConversationChoice || !!onOpenModelSettings || !!agentId)
    if (wantsSwitch && onSwitchModel) {
        actions.push({
            key: 'switch',
            leading: <Icon icon={GaugeIcon} size="sm" />,
            title: 'Switch to another model',
            cta: 'Switch',
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
            description: 'Sign in again on the connection this coworker runs on.',
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
            <div className="flex flex-wrap items-start gap-2">
                <NoticeActions actions={actions} />
                {wantsSwitch && !onSwitchModel && (
                    <DesktopRecoveryModelPicker
                        agentId={agentId}
                        sessionId={sessionId}
                        onPicked={onConversationChoice}
                        onSaved={onModelSaved}
                        onOpenSettings={onOpenModelSettings}
                    />
                )}
            </div>
        </div>
    )
}
