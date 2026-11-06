/** Presentation grouping for I's sealed / show_plan revisions. */

export type DesktopPlanBeats = { trigger: string; working: string; delivered: string }

export type DesktopPlanItemView = {
    key: string
    name: string
    role: string
    when: string
    need?: string
    beats?: DesktopPlanBeats
    gets?: string[]
    boxKey?: string
}

export type DesktopPlanGroupView = { key: string; name: string | null; role: string; items: DesktopPlanItemView[] }

export type DesktopShownPlanView = { title: string; groups: DesktopPlanGroupView[] }

/** Structural mirror of DesktopForemanRevision fields the card needs. */
export type DesktopTrustedPlanSnapshot = {
    planId: string
    revisionId: string
    digest: string
    chatId: string
    workspaceId: string
    runId: string
    state: 'shown' | 'confirmed' | 'changes_requested' | 'superseded'
    streaming: boolean
    /** Sealed plan or raw show_plan input. */
    plan: {
        title: string
        boxes: Array<{ key?: string; name: string; role?: string }>
        items: Array<
            | {
                  key?: string
                  kind: 'agent'
                  name: string
                  role: string
                  need?: string
                  when?: string
                  beats?: DesktopPlanBeats
                  gets?: string[]
                  box?: string
                  boxKey?: string
              }
            | {
                  key?: string
                  kind: 'template'
                  templateId?: string
                  title?: string
                  name?: string
                  slug?: string
                  focus?: string
                  box?: string
                  boxKey?: string
              }
        >
    }
}

export type DesktopPlanDecisionView =
    | { answered: false }
    | { answered: true; confirmed: boolean }

const DEFAULT_TITLE = 'Your first coworker'

function asText(value: unknown): string {
    return typeof value === 'string' ? value : ''
}

function itemName(item: DesktopTrustedPlanSnapshot['plan']['items'][number]): string {
    if (item.kind === 'template') return asText(item.title) || asText(item.name) || asText(item.templateId) || asText(item.slug)
    return item.name
}

/** Group sealed/show_plan items by Box — original readPlan rules. */
export function readTrustedPlan(plan: DesktopTrustedPlanSnapshot['plan']): DesktopShownPlanView {
    const title = asText(plan.title) || DEFAULT_TITLE
    const boxes = plan.boxes ?? []
    const entries = plan.items.map((item, index) => {
        const name = itemName(item)
        const key = item.key ?? `${index}-${name}`
        const view: DesktopPlanItemView = {
            key,
            name,
            role: item.kind === 'agent' ? item.role : asText(item.focus),
            when: item.kind === 'agent' ? asText(item.when) : '',
            ...(item.kind === 'agent' && item.need ? { need: item.need } : {}),
            ...(item.kind === 'agent' && item.beats ? { beats: item.beats } : {}),
            ...(item.kind === 'agent' && item.gets?.length ? { gets: item.gets } : {}),
            ...(item.boxKey ? { boxKey: item.boxKey } : {}),
        }
        const box = item.boxKey
            ? boxes.find(candidate => candidate.key === item.boxKey)?.name ?? ''
            : asText(item.box).trim()
        return { item: view, box, boxKey: item.boxKey }
    }).filter(entry => entry.item.name)

    if (!boxes.length && !entries.some(entry => entry.box || entry.boxKey)) {
        return { title, groups: entries.length ? [{ key: 'all', name: null, role: '', items: entries.map(entry => entry.item) }] : [] }
    }

    const taken = new Set<number>()
    const groups: DesktopPlanGroupView[] = boxes.map((box, index) => {
        const items = entries.flatMap((entry, position) => {
            const match = entry.boxKey
                ? entry.boxKey === box.key
                : entry.box.toLowerCase() === box.name.toLowerCase()
            if (taken.has(position) || !match) return []
            taken.add(position)
            return [entry.item]
        })
        return { key: box.key ?? `box-${index}-${box.name}`, name: box.name, role: asText(box.role), items }
    })

    const orphans = new Map<string, DesktopPlanItemView[]>()
    entries.forEach((entry, position) => {
        if (taken.has(position)) return
        const key = entry.box || entry.boxKey || ''
        orphans.set(key, [...(orphans.get(key) ?? []), entry.item])
    })
    for (const [name, items] of orphans) groups.push({ key: `extra-${name}`, name: name || null, role: '', items })
    return { title, groups }
}

export function projectPlanCard(snapshot: DesktopTrustedPlanSnapshot | null): {
    view: DesktopShownPlanView | null
    streaming: boolean
    decision: DesktopPlanDecisionView | null
    planId: string | null
    revisionId: string | null
    digest: string | null
} {
    if (!snapshot) return { view: null, streaming: false, decision: null, planId: null, revisionId: null, digest: null }
    const view = readTrustedPlan(snapshot.plan)
    const groups = view.groups.filter(group => group.items.length > 0)
    const decision: DesktopPlanDecisionView | null =
        snapshot.state === 'confirmed'
            ? { answered: true, confirmed: true }
            : snapshot.state === 'changes_requested'
              ? { answered: true, confirmed: false }
              : snapshot.state === 'shown'
                ? null
                : { answered: false }
    return {
        view: { ...view, groups },
        streaming: snapshot.streaming,
        decision,
        planId: snapshot.planId,
        revisionId: snapshot.revisionId,
        digest: snapshot.digest,
    }
}

export function planLifeScript(item: Pick<DesktopPlanItemView, 'beats' | 'when'>): DesktopPlanBeats | null {
    if (item.beats) return item.beats
    const trigger = item.when.trim()
    return trigger ? { trigger, working: 'Working on it', delivered: 'Handed over to you' } : null
}

export function revisionToTrustedSnapshot(input: {
    planId: string
    revisionId: string
    digest: string
    chat: { workspaceId: string; chatId: string }
    runId: string
    state: DesktopTrustedPlanSnapshot['state']
    plan: DesktopTrustedPlanSnapshot['plan']
    streaming?: boolean
}): DesktopTrustedPlanSnapshot {
    return {
        planId: input.planId,
        revisionId: input.revisionId,
        digest: input.digest,
        workspaceId: input.chat.workspaceId,
        chatId: input.chat.chatId,
        runId: input.runId,
        state: input.state,
        streaming: input.streaming ?? false,
        plan: input.plan,
    }
}
