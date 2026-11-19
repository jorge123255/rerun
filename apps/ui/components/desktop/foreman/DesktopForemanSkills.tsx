'use client'

import { foremanChatRefSchema, isPinnable, type DesktopForemanChatRef } from '@rerun/contracts'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { Button } from '@/components/ui/button'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelList } from '@/components/ui/panel-list'
import { LayersIcon } from '@/lib/icons'
import { useDesktopLocale } from '../DesktopLocale'
import { DesktopSkillProposalBlock } from '../skills/DesktopSkillProposalBlock'
import { foremanSkillsPath, foremanSkillSummary, type ChiefSkills } from './useDesktopForemanSkills'

const detail = z.object({ chat: foremanChatRefSchema, skill: foremanSkillSummary.extend({ body: z.string() }) })
function ChiefSkillBody({ chat, slug }: { chat: DesktopForemanChatRef; slug: string }) {
    const { t } = useDesktopLocale()
    const [skill, setSkill] = useState<z.infer<typeof detail>['skill'] | null>(null)
    const [failed, setFailed] = useState(false)
    const [retry, setRetry] = useState(0)
    const { workspaceId, chatId } = chat
    useEffect(() => {
        const controller = new AbortController()
        setFailed(false)
        async function read() {
            try {
                const response = await fetch(foremanSkillsPath + '?' + new URLSearchParams({ workspaceId, chatId, slug }), { cache: 'no-store', signal: controller.signal })
                if (!response.ok) throw Error()
                const result = detail.parse(await response.json())
                if (result.chat.chatId !== chatId || result.chat.workspaceId !== workspaceId || result.skill.slug !== slug) throw Error()
                if (!controller.signal.aborted) setSkill(result.skill)
            } catch { if (!controller.signal.aborted) setFailed(true) }
        }
        void read()
        return () => controller.abort()
    }, [workspaceId, chatId, slug, retry])
    if (failed) return <div role="alert">{t('foreman.skillsUnavailable')} <Button size="sm" variant="link" onClick={() => setRetry(n => n + 1)}>{t('coworkerSetup.retry')}</Button></div>
    return skill ? <article><h3 className="font-medium">{skill.name}</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm">{skill.body}</p></article>
        : <p role="status">{t('coworkerSetup.loading')}</p>
}

export function DesktopForemanSkills({ chat, model, slug, open, close }: {
    chat: DesktopForemanChatRef
    model: ChiefSkills
    slug: string | null
    open: (slug: string | null) => void
    close: () => void
}) {
    const { t } = useDesktopLocale()
    const { snapshot, unavailable, decisionFailed, pendingId, decide, refresh } = model
    return <Dialog open onOpenChange={shown => { if (!shown) close() }}>
        <DialogContent className="sm:max-w-2xl">
            <DialogHeaderBar icon={LayersIcon} title={t('coworker.destinations.skills')} actions={slug && <Button size="sm" variant="ghost" onClick={() => open(null)}>{t('routines.back')}</Button>} />
            <div className="max-h-[65vh] space-y-4 overflow-y-auto">
                {slug ? snapshot?.skills.some(skill => skill.slug === slug) ? <ChiefSkillBody key={slug} chat={chat} slug={slug} />
                    : <p role="status">{t(snapshot ? 'foreman.skillsUnavailable' : 'coworkerSetup.loading')}</p>
                : snapshot ? <>
                    <section data-foreman-skill-shelf aria-label={t('coworker.destinations.skills')}>
                        {snapshot.skills.length ? <PanelList>{snapshot.skills.map(skill => <PanelRow key={skill.slug} title={skill.name} description={skill.description} onClick={() => open(skill.slug)} />)}</PanelList>
                        : <p className="text-sm text-muted-foreground">{t('foreman.noSkills')}</p>}
                    </section>
                    {snapshot.proposals.length > 0 && <section data-foreman-skill-decisions className="space-y-1">
                        <h3 className="text-xs font-medium text-muted-foreground">{t('foreman.skillProposals')}</h3>
                        {snapshot.proposals.map(row => <DesktopSkillProposalBlock key={row.id} proposal={row} pending={!!pendingId}
                            onDecide={isPinnable(row.status) ? value => void decide(row.id, value) : undefined}
                            onOpenSkill={row.appliedSlug ? () => open(row.appliedSlug) : undefined} pinned={false} />)}
                    </section>}
                </> : !unavailable && <p role="status">{t('coworkerSetup.loading')}</p>}
                {(unavailable || decisionFailed) && <div role="alert">{t(decisionFailed ? 'foreman.skillDecisionUnclear' : 'foreman.skillsUnavailable')} <Button variant="link" onClick={refresh}>{t('coworkerSetup.retry')}</Button></div>}
            </div>
        </DialogContent>
    </Dialog>
}
