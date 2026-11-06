import { describe, expect, it } from 'vitest'
import { parseDesktopForemanDocs, rankDesktopForemanDocs } from './search'

const CORPUS = `# Automations
Source: https://docs.rerun.build/agents/automations

Make an agent run without you.

## Scheduled tasks

A scheduled task runs an agent on a cron expression, in its own session.

## Webhook triggers

A trigger gives an agent a public URL. Calling it starts a run. Rotate a leaked token.

## Run limits

A run has a bounded duration and can be stopped.

# Billing
Source: https://docs.rerun.build/billing

What a workspace pays for.

## Credit

Every run spends credit. A trial workspace gets two dollars of credit.
`

describe('original documentation parsing and ranking', () => {
    const sections = parseDesktopForemanDocs(CORPUS)

    it('keeps intros and headed sections separate with exact heading citations', () => {
        expect(sections.map(section => [section.page, section.heading])).toEqual([
            ['Automations', null], ['Automations', 'Scheduled tasks'], ['Automations', 'Webhook triggers'], ['Automations', 'Run limits'], ['Billing', null], ['Billing', 'Credit'],
        ])
        expect(sections[2]?.url).toBe('https://docs.rerun.build/agents/automations#webhook-triggers')
        expect(sections[2]?.body).toContain('Rotate a leaked token')
        expect(sections[2]?.body).not.toContain('Billing')
    })

    it('preserves title weighting, query coverage, four results and two per page', () => {
        expect(rankDesktopForemanDocs(sections, 'webhook trigger token')[0]?.heading).toBe('Webhook triggers')
        expect(rankDesktopForemanDocs(sections, 'how much credit does a trial get')[0]?.heading).toBe('Credit')
        const hits = rankDesktopForemanDocs(sections, 'agent run')
        expect(hits).toHaveLength(3)
        expect(hits.filter(section => section.page === 'Automations')).toHaveLength(2)
        expect(rankDesktopForemanDocs(sections, 'kubernetes')).toEqual([])
    })

    it('never creates a citation to another origin', () => {
        const foreign = parseDesktopForemanDocs('# Stolen\nSource: https://example.com/private\n\nDo not cite this.')
        expect(foreign).toEqual([])
    })
})
