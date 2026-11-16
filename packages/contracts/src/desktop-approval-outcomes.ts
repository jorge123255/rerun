// Adapted from CopilotKit/OpenBot shared/approval-outcomes.ts.
// MIT License. Copyright (c) 2026 CopilotKit.
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// subject to the above copyright notice and this permission notice being included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

/**
 * What a coworker is told when a step it asked for was not carried out, and what the person reads
 * for the same step.
 *
 * The sentences are written to the model: they say who decided and what to do next, so the
 * coworker reports it truthfully and does not go looking for another way round. A person never
 * reads "Do not try this action ... again" about their own decision: {@link desktopOutcomeForPerson}
 * gives them the plain version.
 */

/** The person said no. Distinct from a policy or a boundary refusal. */
export const DESKTOP_DECLINED_BY_PERSON =
    'The person declined this action when you asked for their approval, so it was not done. This was their decision, not a policy or a boundary. Do not try this action, or anything equivalent, again in this conversation unless the person asks you to in words; tell them you did not do it because they declined.'

/** The same action asked again while its card is still unanswered. No second request is made. */
export const DESKTOP_ALREADY_WAITING =
    'An identical request is already waiting for the person’s decision on the card in this chat, so this was not done and no second request was made. Do not repeat it; end your turn and wait for their answer.'

/** An approved step that the check just before it ran turned away. `why` is one sentence, with its full stop. */
export function desktopNotDoneOnRecheck(why: string): string {
    return `Not done: ${why} Ask the person again if it is still needed.`
}

/** The approved control was no longer the one under the pointer when the press was about to be made. */
export const DESKTOP_PRESS_CHANGED = desktopNotDoneOnRecheck('the page changed after the person allowed this press, so their answer no longer applies and nothing was pressed.')

const FOR_PERSON = new Map<string, string>([
    [DESKTOP_DECLINED_BY_PERSON, 'You declined it.'],
    [DESKTOP_ALREADY_WAITING, 'It’s already waiting for your answer.'],
])

/**
 * The sentence a person reads for a step the coworker did not carry out. A known sentence is
 * replaced whole. Any other "Not done: <why>." keeps its first sentence and loses the coworker's
 * next step. Anything else is returned as it is.
 */
export function desktopOutcomeForPerson(text: string): string {
    const known = FOR_PERSON.get(text.trim())
    if (known) return known
    if (!text.startsWith('Not done:') && !text.startsWith('Not run:')) return text
    const end = firstSentenceEnd(text)
    return end === -1 ? text : text.slice(0, end + 1)
}

/** Whether a step's answer says the person declined it. */
export function desktopDeclinedByPerson(text: string): boolean {
    return text.trim() === DESKTOP_DECLINED_BY_PERSON
}

/** Where the first sentence ends: a full stop followed by a space, outside any parentheses. */
function firstSentenceEnd(text: string): number {
    let depth = 0
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index]
        if (character === '(') depth += 1
        else if (character === ')') depth = Math.max(0, depth - 1)
        else if (character === '.' && depth === 0 && text[index + 1] === ' ') return index
    }
    return -1
}
