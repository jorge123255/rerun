import { DESKTOP_TRIGGER_TOOL_MESSAGES as M } from '@rerun/contracts'

export type TriggerListRow = {
    name: string
    slug: string
    methods: readonly string[]
    enabled: boolean
    fireCount: number
    lastFiredAt: string | null
}

export type TriggerGetRow = TriggerListRow & {
    description: string
    revision: string
    body: string
}

/** Drop a leaked ingress address. User instruction text is otherwise left intact. */
export function scrubTriggerToolText(text: string): string {
    return text
        .replace(/\/api\/desktop\/trigger-ingress\/\S+/g, '[address omitted]')
        .replace(/Its public URL is[^\n]*/g, M.localOnly)
}

export function projectTriggerList(triggers: TriggerListRow[]): string {
    if (triggers.length === 0) return M.empty
    return [...triggers].sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0).map(trigger => {
        const state = trigger.enabled ? `${trigger.fireCount} call(s)${trigger.lastFiredAt ? `, last ${trigger.lastFiredAt}` : ''}` : 'disabled'
        return `- ${trigger.name} (${trigger.slug}): ${trigger.methods.join('/')}, ${state}`
    }).join('\n')
}

export function projectTriggerGet(trigger: TriggerGetRow): string {
    const lines = [
        `${trigger.name} (${trigger.slug})`,
        trigger.description ? `Description: ${trigger.description}` : '',
        `Methods: ${trigger.methods.join('/')}`,
        `Enabled: ${trigger.enabled}`,
        `Calls: ${trigger.fireCount}${trigger.lastFiredAt ? ` (last ${trigger.lastFiredAt})` : ''}`,
        `Revision: ${trigger.revision}`,
        M.localOnly,
        '',
        trigger.body,
    ]
    return scrubTriggerToolText(lines.filter(line => line !== '').join('\n'))
}
