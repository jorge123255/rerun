import { FOREMAN_DISPLAY_NAME } from './foreman.js'

// The four questions a new conversation with a coworker offers, on every client.
export const COWORKER_STARTER_SUGGESTIONS = ['What can you help me with?', 'Summarize your recent work', 'Review my project files', 'What tools do you have access to?']

export type TeamAgent = { id: string; name: string; handle: string | null; status: string; disabledAt: string | null }

export type TeamEmptyStateAction = { type: 'send' | 'prefill'; text: string }

export type TeamEmptyStateRow = { id: string; title: string; description: string; action: TeamEmptyStateAction } & ({ leading: 'agent'; agentId: string; working: boolean } | { leading: 'build' | 'template' | 'guide' })

export type TeamPulse = {
    agents: { id: string; working: boolean }[]
    working: number
    nextRoutine: { name: string; at: number } | null
}

export type TeamEmptyStateModel = { title: string; subtitle: string | null; pulse: TeamPulse | null; rows: TeamEmptyStateRow[] }

const BUILD_PROMPT = 'Build me a coworker that '

function mentionOf(agent: TeamAgent): string {
    return `@${agent.handle || agent.name}`
}

// What the Foreman opens on when the conversation is empty: a greeting, the team at a glance, and
// three things to ask that send or prefill the composer. `nextRoutine` comes computed: reading cron
// expressions is the caller's business.
export function teamEmptyStateOf({ agents, nextRoutine, firstName }: { agents: TeamAgent[]; nextRoutine: TeamPulse['nextRoutine']; firstName: string }): TeamEmptyStateModel {
    const greeting = firstName ? `Hi ${firstName}, I'm your ${FOREMAN_DISPLAY_NAME}` : `Hi, I'm your ${FOREMAN_DISPLAY_NAME}`
    const team = agents.filter(agent => !agent.disabledAt)

    if (team.length === 0) {
        return {
            title: greeting,
            subtitle: "You have no coworkers yet. Tell me a job you would hand off and I'll build the first one.",
            pulse: null,
            rows: [
                { id: 'build-first', leading: 'build', title: 'Build my first coworker', description: 'Describe the job in a sentence', action: { type: 'prefill', text: BUILD_PROMPT } },
                { id: 'template', leading: 'template', title: 'Start from a template', description: 'Ready-made coworkers for your kind of business', action: { type: 'send', text: 'Show me templates that fit my business' } },
                { id: 'guide', leading: 'guide', title: 'How does this work?', description: 'Coworkers, Boxes, routines, in two minutes', action: { type: 'send', text: 'How does Rerun work?' } },
            ],
        }
    }

    const working = team.filter(agent => agent.status === 'working')
    const featured = working[0] ?? team[0]
    const other = team.find(agent => agent.id !== featured.id) ?? featured
    const featuredWorking = featured.status === 'working'

    return {
        title: `${greeting}. Here is your team.`,
        subtitle: null,
        pulse: {
            agents: team.map(agent => ({ id: agent.id, working: agent.status === 'working' })),
            working: working.length,
            nextRoutine,
        },
        rows: [featuredWorking ? { id: 'check', leading: 'agent', agentId: featured.id, working: true, title: `What is ${featured.name} doing?`, description: 'Working now', action: { type: 'send', text: `What is ${mentionOf(featured)} doing right now?` } } : { id: 'check', leading: 'agent', agentId: featured.id, working: false, title: `What did ${featured.name} do today?`, description: 'Catch up on its latest runs', action: { type: 'send', text: `What did ${mentionOf(featured)} do today?` } }, { id: 'hand-off', leading: 'agent', agentId: other.id, working: other.status === 'working', title: `Give ${other.name} a task`, description: 'I brief it and follow it through', action: { type: 'prefill', text: `Ask ${mentionOf(other)} to ` } }, { id: 'build', leading: 'build', title: 'Build a new coworker', description: 'For a job nobody on the team does yet', action: { type: 'prefill', text: BUILD_PROMPT } }],
    }
}
