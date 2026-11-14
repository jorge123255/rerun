'use client'

import { Badge } from '@rerun/ui/primitives'
import type { DesktopDocumentReference } from '@rerun/contracts'
import { ReceiptCard } from '@/components/chat/ReceiptCard'
import { Button } from '@/components/ui/button'
import { CheckIcon, MessageCircleQuestionIcon, ShieldCheckIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DesktopSavedChatDecision } from '@/lib/desktop/saved-chat-decision'
import { useDesktopLocale } from './DesktopLocale'

export function DesktopSavedDecisionReceipt({ decision, documents, onOpenDocument }: {
    decision: DesktopSavedChatDecision
    documents: readonly DesktopDocumentReference[]
    onOpenDocument?: (index: number, trigger: HTMLButtonElement) => void
}) {
    const { t } = useDesktopLocale()
    if (decision.kind === 'question-dismissed') {
        return <p className="ml-auto max-w-[85%] text-xs text-muted-foreground">{t('chatReceipt.dismissed.question')}</p>
    }
    if (decision.kind === 'approvals') {
        const total = decision.items.length
        const approved = decision.items.filter(item => item.decision === 'approved').length
        const declined = total - approved
        const meta = total < 2 ? undefined : approved && declined ? t('chatReceipt.approvals.metaBoth', { approved, declined })
            : approved ? t('chatReceipt.approvals.metaApproved', { approved }) : t('chatReceipt.approvals.metaDeclined', { declined })
        return <ReceiptCard icon={ShieldCheckIcon} title={t(total === 1 ? 'chatReceipt.approvals.title.one' : 'chatReceipt.approvals.title.other')} meta={meta}>
            {decision.items.map((item, index) => <div key={index} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                    <p className={cn('wrap-anywhere whitespace-pre-wrap text-sm', item.decision === 'declined' && 'text-muted-foreground line-through')}>{item.action}</p>
                    {item.detail && <p className="mt-0.5 wrap-anywhere whitespace-pre-wrap text-xs text-muted-foreground">{item.detail}</p>}
                    {item.note && <p className="mt-1 wrap-anywhere whitespace-pre-wrap text-xs text-foreground/80">“{item.note}”</p>}
                </div>
                <Badge size="xs" tone={item.decision === 'approved' ? 'green' : 'red'} glow={false} className="mt-0.5 shrink-0">
                    {t(item.decision === 'approved' ? 'chatReceipt.status.approved' : 'chatReceipt.status.notNow')}
                </Badge>
            </div>)}
        </ReceiptCard>
    }

    const total = decision.items.length
    const answered = decision.items.filter(item => item.answers.length || item.attachmentIds.length).length
    return <ReceiptCard icon={MessageCircleQuestionIcon} title={t(total === 1 ? 'chatReceipt.answers.title.one' : 'chatReceipt.answers.title.other')}
        meta={total > 1 ? t('chatReceipt.answers.meta', { answered, total }) : undefined}>
        {decision.items.map((item, index) => <div key={index} className="flex min-w-0 flex-col gap-1.5 px-3 py-2.5">
            <p className="wrap-anywhere whitespace-pre-wrap text-xs text-muted-foreground">{item.question}</p>
            {item.answers.length === 0 && item.attachmentIds.length === 0 && <p className="text-sm italic text-muted-foreground">{t('chatReceipt.status.skipped')}</p>}
            {item.answers.length > 0 && (item.fromOptions || item.answers.length > 1
                ? <ul className="flex flex-col gap-1">{item.answers.map((answer, answerIndex) => <li key={answerIndex} className="flex items-start gap-1.5 wrap-anywhere whitespace-pre-wrap text-sm">
                    <CheckIcon aria-hidden className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" />{answer}
                </li>)}</ul>
                : <p className="wrap-anywhere whitespace-pre-wrap text-sm">{item.answers[0]}</p>)}
            {item.attachmentIds.length > 0 && <div className="flex flex-wrap gap-1">
                {item.attachmentIds.map(id => {
                    const at = documents.findIndex(file => file.attachmentId === id)
                    if (at < 0) return null
                    return <Button key={id} type="button" size="sm" variant="secondary" disabled={!onOpenDocument} onClick={event => onOpenDocument?.(at, event.currentTarget)}
                        className="max-w-full"><span className="truncate">{documents[at].name}</span></Button>
                })}
            </div>}
        </div>)}
    </ReceiptCard>
}
