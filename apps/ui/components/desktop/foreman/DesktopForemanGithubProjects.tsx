'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import type { DesktopIntakeGithubController } from '@/lib/desktop/foreman-intake/use-desktop-intake-github'
import { githubTeamAccessClient, githubTeamReady, giveGithubToTeam, type DesktopGithubTeamAccess, type GithubTeamAccessPorts } from '@/lib/desktop/github-team-access'
import { BoxIcon, ChevronDownIcon, ChevronUpIcon } from '@/lib/icons'
import { DesktopIntakeGithubProjects } from './intake/DesktopIntakeGithubProjects'

const REVIEW = { restored: true, finished: false } as const
/** What Update the proposal sends: the person's own words to the Chief of Staff. */
export const DESKTOP_GITHUB_UPDATE_PROPOSAL = 'I changed the GitHub projects in Review. Update the proposal to match the projects, roles and links as they are saved now.'

/**
 * The GitHub projects of a conversation, above its message box: the repositories linked in its
 * messages, read by this Mac. One line says how many there are; opening it shows the same review
 * the intake has, where the owner removes a repository, changes its kind, roles and links.
 *
 * Two things the review alone could not do sit here too. After an edit, Update the proposal asks
 * the Chief of Staff for a new card, so the owner does not have to describe the edit in words.
 * And once coworkers exist for these projects, Give GitHub to the team assigns the GitHub sign-in
 * to all of them in one step, after saying exactly what that gives.
 */
export function DesktopForemanGithubProjects({ github, chat, onSend, sendDisabled, refreshKey, accessPorts }: {
    github: DesktopIntakeGithubController
    chat: { workspaceId: string; chatId: string }
    onSend?: (text: string) => void
    sendDisabled?: boolean
    /** Changes when the conversation's plan or build does: the team is read again. */
    refreshKey?: string
    accessPorts?: GithubTeamAccessPorts
}) {
    const [open, setOpen] = useState(false)
    const [edited, setEdited] = useState(false)
    const [access, setAccess] = useState<DesktopGithubTeamAccess | null>(null)
    const [asking, setAsking] = useState(false)
    const [giving, setGiving] = useState(false)
    const [notice, setNotice] = useState<string | null>(null)
    const ports = useMemo(() => accessPorts ?? githubTeamAccessClient({ workspaceId: chat.workspaceId, chatId: chat.chatId }), [accessPorts, chat.workspaceId, chat.chatId])
    const projects = github.record?.projects.filter(project => !project.removed) ?? []
    const shown = projects.length > 0

    const run = useRef(0)
    useEffect(() => {
        if (!shown) return
        const mine = ++run.current
        ports.read().then(next => { if (run.current === mine) setAccess(next) }).catch(() => {})
    }, [ports, shown, refreshKey])
    // A new message was sent: the edits before it are part of that conversation now.
    useEffect(() => { setEdited(false) }, [refreshKey])

    // The review's own edit, noted so the bar can offer to pass it on.
    const edit = github.edit
    const reviewed = useMemo(() => ({ ...github, edit: (change: Parameters<typeof edit>[0]) => { setEdited(true); edit(change) } }), [github, edit])

    const give = useCallback(() => {
        setGiving(true); setNotice(null)
        giveGithubToTeam(ports).then(result => {
            setAccess(result.access); setAsking(false)
            setNotice(result.failed ? `${result.failed} ${result.failed === 1 ? 'coworker was' : 'coworkers were'} not given GitHub. ${result.message ?? ''}`.trim() : null)
        }).catch(error => setNotice(error instanceof Error && error.message ? error.message : 'GitHub could not be given to the team.')).finally(() => setGiving(false))
    }, [ports])

    if (!shown) return null
    const read = projects.filter(project => project.state === 'read').length
    const label = read === projects.length
        ? `${read} GitHub ${read === 1 ? 'project' : 'projects'} read`
        : `${read} of ${projects.length} GitHub projects read`
    const team = access?.team ?? []
    const ready = team.filter(githubTeamReady).length
    const count = (value: number) => `${value} ${value === 1 ? 'coworker' : 'coworkers'}`
    return (
        <section data-foreman-github-projects aria-label="GitHub projects" className="mx-3 mt-2 rounded-lg border bg-muted/30 text-xs">
            <button type="button" data-foreman-github-toggle aria-expanded={open} onClick={() => setOpen(value => !value)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Icon icon={BoxIcon} size="xs" />
                <span className="min-w-0 flex-1 truncate"><span className="font-medium">{label}</span><span className="text-muted-foreground"> · {projects.map(project => project.name).join(', ')}</span></span>
                <span className="shrink-0 text-muted-foreground">{open ? 'Hide' : 'Review'}</span>
                <Icon icon={open ? ChevronDownIcon : ChevronUpIcon} size="xs" />
            </button>
            {edited && onSend && <div data-foreman-github-update className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
                <p className="min-w-0 flex-1 text-muted-foreground">You changed these projects. The proposal does not show it yet.</p>
                <Button type="button" size="sm" variant="outline" disabled={sendDisabled} onClick={() => { setEdited(false); onSend(DESKTOP_GITHUB_UPDATE_PROPOSAL) }}>Update the proposal</Button>
            </div>}
            {team.length > 0 && <div data-foreman-github-access className="border-t px-3 py-2">
                {ready === team.length
                    ? <p className="text-muted-foreground">All {count(team.length)} of these projects can use GitHub. Every change to a repository still asks you first.</p>
                    : !access?.via
                        ? <p className="text-muted-foreground">{ready} of {count(team.length)} can use GitHub. Sign in to GitHub in the Vault, then give it to the team here.</p>
                        : !asking
                            ? <div className="flex flex-wrap items-center gap-2">
                                <p className="min-w-0 flex-1 text-muted-foreground">{ready} of {count(team.length)} can use GitHub.</p>
                                <Button type="button" size="sm" variant="outline" data-foreman-github-give onClick={() => { setAsking(true); setNotice(null) }}>Give GitHub to the team</Button>
                            </div>
                            : <div className="space-y-2">
                                <p className="leading-relaxed">
                                    {access.via === 'composio-connect'
                                        ? <>This assigns your Composio sign-in to {count(team.length - ready)} and turns on Custom MCP servers for them. {access.alsoGives.length > 0
                                            ? <>Composio hands out every app you signed in to together, so they will also reach {access.alsoGives.join(', ')}. </> : null}</>
                                        : <>This assigns your GitHub account to {count(team.length - ready)}. </>}
                                    Sending, posting and changes to a repository still ask you first. You can take it back in the Vault.
                                </p>
                                <div className="flex gap-2">
                                    <Button type="button" size="sm" data-foreman-github-give-confirm loading={giving} disabled={giving} onClick={give}>Give access</Button>
                                    <Button type="button" size="sm" variant="ghost" disabled={giving} onClick={() => setAsking(false)}>Cancel</Button>
                                </div>
                            </div>}
                {notice && <p role="alert" className="mt-1.5 text-destructive">{notice}</p>}
            </div>}
            {open && <div className="max-h-[40vh] overflow-y-auto border-t px-2 py-2">
                <DesktopIntakeGithubProjects github={reviewed} intake={REVIEW} />
            </div>}
        </section>
    )
}
