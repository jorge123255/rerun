'use client'

import { StarterPackWidget } from '@/components/foreman/widgets/starter-pack/StarterPackWidget'
import { Button } from '@/components/ui/button'
import type { DesktopLocalStarterDecision, DesktopStarterView } from '@/lib/desktop/foreman-client/starter'

type Choice = DesktopLocalStarterDecision['choice']

export function DesktopStarterOfferCard({ offer, disabled, onAnswer, onStop }: {
    offer: DesktopStarterView
    disabled: boolean
    onAnswer: (choice: Choice) => void
    onStop: () => void
}) {
    const cards = offer.cards.map(card => ({ slug: card.templateId, title: card.title, promise: card.title }))
    const decision = offer.decision
    const choice = decision?.choice
    if (decision?.settled && choice) {
        const output = choice.kind === 'text' ? { answered: true, custom: choice.text }
            : choice.kind === 'cards' ? { answered: true, chosen: choice.chosen } : { answered: false }
        return <StarterPackWidget desktopReview input={{ cards }} output={output} onAnswer={() => {}} />
    }
    return (
        <section aria-label="Starter team">
            {choice ? <div className="mb-2 space-y-2">
                <p role="status" className="text-sm">Your Chief of Staff is waiting to finish your starter choice.</p>
                <Button type="button" size="sm" disabled={disabled} onClick={() => onAnswer(choice)}>Retry choice</Button>
            </div> : (
                <fieldset disabled={disabled} className="min-w-0">
                    <StarterPackWidget desktopReview input={{ cards }} onAnswer={answer => onAnswer(
                        !answer.answered ? { kind: 'dismiss' } : 'custom' in answer
                            ? { kind: 'text', text: answer.custom } : { kind: 'cards', chosen: answer.chosen },
                    )} />
                </fieldset>
            )}
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={choice ? onStop : () => onAnswer({ kind: 'dismiss' })}>
                {choice ? 'Stop' : 'Dismiss'}
            </Button>
        </section>
    )
}
