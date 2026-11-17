'use client'

import { checkedDesktopCoworkerMentions, teamEmptyStateOf, type DesktopCoworkerMention, type TeamAgent } from '@rerun/contracts'
import { ForemanTeamEmptyState } from '@/components/foreman/empty-state/ForemanTeamEmptyState'
import { WELCOME_ORB_SIZE } from '@rerun/ui/foreman'
import { useDesktopLocale } from '../DesktopLocale'
import { DesktopForemanOrb } from '../panel-motion/DesktopForemanOrb'

export const DESKTOP_GITHUB_WELCOME = { title: 'Build a team from GitHub projects', description: 'Paste repository links, private ones too' } as const
export const DESKTOP_GITHUB_WELCOME_PROMPT = 'Build a team for these GitHub projects: '
// A Mac addition: the Chief of Staff walks the person through models, permissions and setup for the
// whole team and puts the result on one card, so nobody opens each coworker's settings in turn.
export const DESKTOP_TEAM_SETUP_WELCOME = { title: 'Set up my team', description: 'Models, permissions and setup, in a few questions' } as const
export const DESKTOP_TEAM_SETUP_PROMPT = 'Set up my team: walk me through the models, permissions and setup for my coworkers, then put the changes on one card.'

export function DesktopForemanTeamWelcome({ agents, firstName, nextRoutine, now, disabled, onAction }: {
    agents: TeamAgent[]
    firstName: string
    nextRoutine?: { name: string; at: number }
    now?: number
    disabled: boolean
    onAction: (text: string, mentions: DesktopCoworkerMention[], submit: boolean) => void
}) {
    const { t, language } = useDesktopLocale()
    // The cloud's own words for this welcome (« I'm your Chief of Staff »), not the phone app's.
    const team = language.messages.foreman.teamWelcome
    const model = teamEmptyStateOf({ agents, firstName, nextRoutine: nextRoutine ?? null, copy: {
        greeting: name => name ? t('foreman.teamWelcome.greetingNamed', { firstName: name }) : team.greeting,
        greetingWithTeam: greeting => t('foreman.teamWelcome.greetingWithTeam', { greeting }),
        emptySubtitle: team.emptySubtitle,
        buildPrompt: team.buildPrompt,
        buildFirst: team.buildFirst,
        template: team.template,
        guide: team.guide,
        checkWorking: (name, mention) => ({
            title: t('foreman.teamWelcome.checkWorking.title', { name }), description: team.checkWorking.description,
            send: t('foreman.teamWelcome.checkWorking.send', { mention }),
        }),
        checkIdle: (name, mention) => ({
            title: t('foreman.teamWelcome.checkIdle.title', { name }), description: team.checkIdle.description,
            send: t('foreman.teamWelcome.checkIdle.send', { mention }),
        }),
        handOff: (name, mention) => ({
            title: t('foreman.teamWelcome.handOff.title', { name }), description: team.handOff.description,
            prefill: t('foreman.teamWelcome.handOff.prefill', { mention }),
        }),
        build: team.build,
    } })
    // A Mac addition: the Chief of Staff reads any GitHub repositories linked in a message, so the
    // welcome says so. It sits after the first choice and starts the sentence for the links.
    const rows = [...model.rows]
    rows.splice(1, 0, { id: 'github-projects', leading: 'build', ...DESKTOP_GITHUB_WELCOME, action: { type: 'prefill', text: DESKTOP_GITHUB_WELCOME_PROMPT } })
    if (agents.length > 0) rows.splice(1, 0, { id: 'team-setup', leading: 'build', ...DESKTOP_TEAM_SETUP_WELCOME, action: { type: 'send', text: DESKTOP_TEAM_SETUP_PROMPT } })
    return <ForemanTeamEmptyState model={{ ...model, rows }} now={now} disabled={disabled} orb={<DesktopForemanOrb role="welcome" size={WELCOME_ORB_SIZE} />}
        // An empty conversation (a new task, or General before its first message) fades its welcome in.
        className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out motion-reduce:animate-none"
        pulseLabels={(count, working) => ({ coworkers: t('chatStart.pulseCoworkers', { count }), working: t('chatStart.pulseWorking', { count: working }) })}
        onAction={row => {
            if (disabled) return
            const { text, type } = row.action
            if (row.leading !== 'agent') { onAction(text, [], type === 'send'); return }
            const owner = agents.find(agent => agent.id === row.agentId && !agent.disabledAt)
            if (!owner) return
            const token = `@${owner.handle || owner.name}`
            const start = text.indexOf(token)
            let mentions: DesktopCoworkerMention[]
            try { mentions = checkedDesktopCoworkerMentions(text, [{ targetId: owner.id, token, start, end: start + token.length }]) }
            catch { return }
            onAction(text, mentions, type === 'send')
        }}
    />
}
