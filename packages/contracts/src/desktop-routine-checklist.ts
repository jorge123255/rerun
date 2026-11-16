/*
 * The parser (routineParts, inlineSteps, the list and status patterns, normal, shorten) is copied
 * from CopilotKit/OpenBot, shared/routine-checklist.ts.
 *
 * MIT License
 * Copyright (c) 2026 CopilotKit
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above copyright notice and this
 * permission notice shall be included in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 *
 * Rerun's own part starts at `routineChecklistOutcome`: reading each part's outcome and reason out
 * of the final reply, and the short summary the last-result view shows.
 */
import { z } from 'zod'

/**
 * A list longer than this is data rather than parts: twenty issue ids to look at are one job, not
 * twenty, and a checklist of twenty would ask for twenty status lines.
 */
export const ROUTINE_MOST_PARTS = 10

/** How much of a part is kept, in code points. */
const PART_SHOWN = 80

const LIST_ITEM = /^(\s*)(?:[-*•+]|\d{1,2}[.)]|[a-z][.)])\s+(\S.*)$/i

/**
 * The parts of an instruction written as a list, or none.
 *
 * Only the outermost list counts: an indented line under a part is that part's detail, not a part
 * of its own. Fewer than two items is not a multi-part routine, and more than
 * {@link ROUTINE_MOST_PARTS} is a list of things to work through rather than a list of parts.
 */
export function routineParts(instruction: string): string[] {
    const items: { indent: number; text: string }[] = []
    for (const line of instruction.split(/\r?\n/)) {
        const match = LIST_ITEM.exec(line)
        if (!match) continue
        items.push({
            indent: (match[1] ?? '').replace(/\t/g, '    ').length,
            text: (match[2] ?? '').replace(/\s+/g, ' ').trim(),
        })
    }
    if (items.length === 0) return inlineSteps(instruction)
    const outer = Math.min(...items.map(item => item.indent))
    const parts = items
        .filter(item => item.indent === outer && item.text.length > 0)
        .map(item => shorten(item.text))
    return parts.length >= 2 && parts.length <= ROUTINE_MOST_PARTS ? parts : []
}

/** A step number in running text: "1)" or "1." after a space, before the step's words. */
const INLINE_STEP = /(?:^|\s)(\d{1,2})[.)]\s+/g

/**
 * The parts of an instruction whose steps are numbered in one paragraph ("Steps: 1) read the cycle
 * 2) read the page 3) rank"). Only a run counted 1, 2, 3 in order is steps: a version number has no
 * space after its dot, and numbers out of order are references, not steps. Words after the last
 * step stay with it.
 */
function inlineSteps(instruction: string): string[] {
    const text = instruction.replace(/\s+/g, ' ')
    const steps: { at: number; from: number }[] = []
    for (const mark of text.matchAll(INLINE_STEP)) {
        if (Number(mark[1]) !== steps.length + 1) continue
        steps.push({ at: mark.index, from: mark.index + mark[0].length })
    }
    if (steps.length < 2 || steps.length > ROUTINE_MOST_PARTS) return []
    return steps.map((step, index) => shorten(text.slice(step.from, steps[index + 1]?.at ?? text.length).trim()))
}

const STATUS = /\b(done|blocked|skipped)\b/i

/** "1.", "2)", "Part 3:", "#4 -", "5 |", as a line that closes a part starts. */
const NUMBERED = /^(?:part|item|step)?\s*#?(\d{1,2})\s*(?:[.):|\]–—-]|\s(?=done|blocked|skipped))/i

function normal(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
}

function shorten(text: string): string {
    const points = Array.from(text)
    return points.length <= PART_SHOWN ? text : `${points.slice(0, PART_SHOWN - 1).join('')}…`
}

// ---- Rerun's own: the outcome of each part, read from the final reply ----

const REASON_MAX = 300

export const desktopRoutinePartOutcomeSchema = z.object({
    number: z.number().int().min(1).max(ROUTINE_MOST_PARTS),
    text: z.string().max(200),
    /** `open` is a part the reply's list did not close. */
    status: z.enum(['done', 'blocked', 'skipped', 'open']),
    reason: z.string().max(REASON_MAX).nullable(),
}).strict()
export type DesktopRoutinePartOutcome = z.infer<typeof desktopRoutinePartOutcomeSchema>

export const desktopRoutineChecklistSchema = z.object({
    /** False when the reply carried no closing list at all: "no checklist reported", not a failure. */
    reported: z.boolean(),
    parts: z.array(desktopRoutinePartOutcomeSchema).max(ROUTINE_MOST_PARTS),
}).strict()
export type DesktopRoutineChecklist = z.infer<typeof desktopRoutineChecklistSchema>

/** What one routine run left behind for the last-result view. */
export const desktopRoutineRunOutcomeSchema = z.object({
    /** The reply was only the "nothing to report" marker. */
    quiet: z.boolean(),
    /** Started by hand with Run now. */
    test: z.boolean(),
    /** Null when the routine's text has no numbered parts. */
    checklist: desktopRoutineChecklistSchema.nullable(),
}).strict()
export type DesktopRoutineRunOutcome = z.infer<typeof desktopRoutineRunOutcomeSchema>

function reasonOf(rest: string): string | null {
    const reason = rest.replace(/^[\s:;,.()\[\]|*_`–—-]+/, '').replace(/[\s()\[\]|*_`]+$/, '').replace(/\s+/g, ' ').trim()
    return reason ? Array.from(reason).slice(0, REASON_MAX).join('') : null
}

/**
 * Each part's outcome, as the reply closed it. A part is closed by a line that names it (by its
 * number, or by the start of its own words) and says Done, Blocked or Skipped. The last such line
 * for a part wins, since the closing list comes at the end. A reply that closes no part at all is
 * recorded as `reported: false`.
 */
export function routineChecklistOutcome(parts: readonly string[], said: string): DesktopRoutineChecklist {
    const closed = new Map<number, { status: 'done' | 'blocked' | 'skipped'; reason: string | null }>()
    for (const raw of said.split(/\r?\n/)) {
        const line = raw.replace(/^[^\p{L}\p{N}]+/u, '')
        const numbered = NUMBERED.exec(line)
        // Read the status after the part's number, so "2. Skipped: already done" is skipped.
        const tail = numbered ? line.slice(numbered[0].length) : line
        const status = STATUS.exec(tail)
        if (!status) continue
        const outcome = { status: status[1].toLowerCase() as 'done' | 'blocked' | 'skipped', reason: reasonOf(tail.slice(status.index + status[0].length)) }
        if (numbered) {
            const number = Number(numbered[1])
            if (number >= 1 && number <= parts.length) closed.set(number, outcome)
            continue
        }
        const words = normal(line)
        parts.forEach((part, index) => {
            const start = normal(part).slice(0, 30)
            if (start.length >= 8 && words.includes(start)) closed.set(index + 1, outcome)
        })
    }
    return {
        reported: closed.size > 0,
        parts: parts.slice(0, ROUTINE_MOST_PARTS).map((text, index) => {
            const outcome = closed.get(index + 1)
            return { number: index + 1, text: Array.from(text).slice(0, 200).join(''), status: outcome?.status ?? 'open', reason: outcome?.status === 'done' ? null : outcome?.reason ?? null }
        }),
    }
}

/** "3 done, 1 blocked: <reason>". The reasons of blocked and skipped parts follow their counts. */
export function routineChecklistSummary(checklist: DesktopRoutineChecklist, labels: { done: string; blocked: string; skipped: string; open: string; none: string } = { done: 'done', blocked: 'blocked', skipped: 'skipped', open: 'not reported', none: 'no checklist reported' }): string {
    if (!checklist.reported) return labels.none
    const pieces: string[] = []
    for (const status of ['done', 'blocked', 'skipped', 'open'] as const) {
        const rows = checklist.parts.filter(part => part.status === status)
        if (!rows.length) continue
        const reasons = status === 'done' || status === 'open' ? [] : rows.map(row => row.reason).filter((reason): reason is string => Boolean(reason))
        pieces.push(`${rows.length} ${labels[status]}${reasons.length ? `: ${reasons.join('; ')}` : ''}`)
    }
    return pieces.join(', ')
}
