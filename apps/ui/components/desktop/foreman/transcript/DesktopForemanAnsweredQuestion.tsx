'use client'

import type { DesktopAnsweredQuestionRecap } from '@/lib/desktop/foreman/answered-question-recap'

/** Read-only reopening of a saved Foreman ask_user selection. It deliberately renders labels only:
 * no request id, guard digest, run identity or action controls are kept or shown. */
export function DesktopForemanAnsweredQuestion({ recaps }: { recaps: readonly DesktopAnsweredQuestionRecap[] }) {
    if (!recaps.length) return null
    return <div className="flex min-w-0 flex-col gap-2" data-foreman-answered-question="true">
        {recaps.map(recap => <div key={recap.key} className="min-w-0 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm">
            {recap.questions.map((item, index) => <div key={`${recap.key}:${index}`} className={index > 0 ? 'mt-2 min-w-0' : 'min-w-0'}>
                <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{item.question}</p>
                <p className="whitespace-pre-wrap break-words text-foreground">{item.answers.length ? item.answers.join(', ') : 'Skipped'}</p>
            </div>)}
        </div>)}
    </div>
}
