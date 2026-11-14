'use client'

import { checkedDesktopCoworkerMentions, teamEmptyStateOf, type DesktopCoworkerMention, type TeamAgent } from '@rerun/contracts'
import { ForemanTeamEmptyState } from '@/components/foreman/empty-state/ForemanTeamEmptyState'
import { useDesktopLocale } from '../DesktopLocale'

export function DesktopForemanTeamWelcome({ agents, firstName, nextRoutine, now, disabled, onAction }: {
    agents: TeamAgent[]
    firstName: string
    nextRoutine?: { name: string; at: number }
    now?: number
    disabled: boolean
    onAction: (text: string, mentions: DesktopCoworkerMention[], submit: boolean) => void
}) {
    const { t, language } = useDesktopLocale()
    const team = language.messages.chatStart.team
    const model = teamEmptyStateOf({ agents, firstName, nextRoutine: nextRoutine ?? null, copy: {
        greeting: name => name ? t('chatStart.team.greetingNamed', { firstName: name }) : team.greeting,
        greetingWithTeam: greeting => t('chatStart.team.greetingWithTeam', { greeting }),
        emptySubtitle: team.emptySubtitle,
        buildPrompt: team.buildPrompt,
        buildFirst: team.buildFirst,
        template: team.template,
        guide: team.guide,
        checkWorking: (name, mention) => ({
            title: t('chatStart.team.checkWorking.title', { name }), description: team.checkWorking.description,
            send: t('chatStart.team.checkWorking.send', { mention }),
        }),
        checkIdle: (name, mention) => ({
            title: t('chatStart.team.checkIdle.title', { name }), description: team.checkIdle.description,
            send: t('chatStart.team.checkIdle.send', { mention }),
        }),
        handOff: (name, mention) => ({
            title: t('chatStart.team.handOff.title', { name }), description: team.handOff.description,
            prefill: t('chatStart.team.handOff.prefill', { mention }),
        }),
        build: team.build,
    } })
    return <ForemanTeamEmptyState model={model} now={now} disabled={disabled}
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
