import type { UIMessage } from 'ai'

import { ONBOARDING_STEPS } from '@/mocks/onboarding'

import { buildTasks, isKickoff, pendingWidget, readBuildResult, readPlan } from './parts'

describe('pendingWidget', () => {
    it('stops on the card the last message still waits on', () => {
        expect(pendingWidget(ONBOARDING_STEPS.plan)?.widget).toBe('show_plan')
        expect(pendingWidget(ONBOARDING_STEPS.pack)?.widget).toBe('show_starter_pack')
    })

    it('waits on nothing once the person wrote back, nor on a build', () => {
        expect(pendingWidget(ONBOARDING_STEPS.typed)).toBeNull()
        expect(pendingWidget(ONBOARDING_STEPS.building)).toBeNull()
    })
})

describe('readPlan', () => {
    it('keeps the declared Boxes in order, drops the empty ones, and never drops an agent', () => {
        const plan = readPlan({
            title: 'Team',
            boxes: [{ name: 'Sales' }, { name: 'Ops' }],
            items: [
                { name: 'Scout', role: 'Finds leads', box: 'sales' },
                { name: 'Ledger', role: 'Chases invoices', box: 'Finance' },
            ],
        })
        expect(plan.boxes.map(box => [box.name, box.agents.map(agent => agent.name)])).toEqual([
            ['Sales', ['Scout']],
            ['Finance', ['Ledger']],
        ])
    })
})

describe('the build', () => {
    it('reads the last progress the hub sent, and the coworker to start first', () => {
        const built = ONBOARDING_STEPS.built
        const message = built[built.length - 1]
        expect(buildTasks(message, 'build').map(task => task.status)).toEqual(['done', 'done', 'done'])
        const output = (message.parts.find(part => part.type === 'tool-build_team') as { output: unknown }).output
        expect(readBuildResult(output)?.lead).toEqual({ agentId: 'agent-scout', name: 'Lead Scout' })
    })
})

it('reads the app opening the conversation as nobody writing', () => {
    expect(isKickoff({ id: 'k', role: 'user', parts: [{ type: 'text', text: '[[foreman:start]]' }] } as UIMessage)).toBe(true)
    expect(isKickoff({ id: 'u', role: 'user', parts: [{ type: 'text', text: 'Hello' }] } as UIMessage)).toBe(false)
})
