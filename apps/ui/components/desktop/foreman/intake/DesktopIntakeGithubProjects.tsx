'use client'

import { useRef, useState } from 'react'
import {
    DESKTOP_GITHUB_LINK_KINDS,
    DESKTOP_GITHUB_PROJECT_KINDS,
    DESKTOP_GITHUB_PROJECT_KIND_LABELS,
    DESKTOP_GITHUB_PROJECT_ROLES,
    DESKTOP_GITHUB_PROJECT_ROLE_LABELS,
    DESKTOP_GITHUB_READ_FAILURE_COPY,
    githubProjectLinkLine,
    type DesktopGithubLinkKind,
    type DesktopGithubProject,
    type DesktopGithubProjectKind,
} from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import type { DesktopIntakeGithubController } from '@/lib/desktop/foreman-intake/use-desktop-intake-github'
import { BoxIcon, XIcon } from '@/lib/icons'
import { DISCOVERY_CARD_CLASS } from '../discoveries/DesktopDiscoveryCard'
import { DesktopArrive } from '../../panel-motion/DesktopArrive'

const SELECT = 'rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

function ProjectCard({ project, disabled, github, live, order }: { project: DesktopGithubProject; disabled: boolean; github: DesktopIntakeGithubController; live: boolean; order: number }) {
    return (
        <DesktopArrive as="li" id={`github-project:${project.id}`} live={live} delayMs={Math.min(order, 8) * 60} data-intake-github-project={project.id} className={`${DISCOVERY_CARD_CLASS} text-left`}>
            <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                    <p className="truncate font-heading text-sm font-medium">{project.name}</p>
                    <p className="truncate text-[10px] text-muted-foreground/80">Read from GitHub · {project.owner}/{project.name}</p>
                </div>
                <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove ${project.name}`} title="Remove this repository"
                    disabled={disabled} onClick={() => github.edit({ type: 'remove-repository', id: project.id })}><XIcon /></Button>
            </div>
            {project.state === 'unavailable' ? (
                <p data-intake-github-unread className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{DESKTOP_GITHUB_READ_FAILURE_COPY[project.failure ?? 'failed']}</p>
            ) : <>
                <div className="mt-1.5 flex items-center gap-1.5">
                    <label className="text-[10px] font-medium text-muted-foreground" htmlFor={`kind-${project.id}`}>Kind</label>
                    <select id={`kind-${project.id}`} aria-label={`Kind of ${project.name}`} className={SELECT} value={project.kind} disabled={disabled}
                        onChange={event => github.edit({ type: 'set-kind', id: project.id, kind: event.target.value as DesktopGithubProjectKind })}>
                        {DESKTOP_GITHUB_PROJECT_KINDS.map(kind => <option key={kind} value={kind}>{DESKTOP_GITHUB_PROJECT_KIND_LABELS[kind]}</option>)}
                    </select>
                </div>
                {/* Repository text is shown as plain text only. */}
                {project.purpose && <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed">{project.purpose}</p>}
                {project.stack.length > 0 && <p className="mt-1 truncate text-[11px] text-muted-foreground">{project.stack.join(' · ')}</p>}
                {project.build && <p className="mt-1 truncate text-[11px] text-muted-foreground">Build: {project.build}</p>}
                <fieldset className="mt-2" disabled={disabled}>
                    <legend className="text-[10px] font-medium text-muted-foreground">Suggested coworkers</legend>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                        {DESKTOP_GITHUB_PROJECT_ROLES.map(role => (
                            <label key={role} className="flex items-center gap-1 text-[11px]">
                                <input type="checkbox" className="size-3 accent-current" data-intake-github-role={role} checked={project.roles.includes(role)}
                                    onChange={event => github.edit({ type: 'set-role', id: project.id, role, on: event.target.checked })} />
                                {DESKTOP_GITHUB_PROJECT_ROLE_LABELS[role]}
                            </label>
                        ))}
                    </div>
                </fieldset>
            </>}
        </DesktopArrive>
    )
}

/**
 * What was read from the owner's GitHub repositories, for review before the Chief of Staff
 * proposes a team from it: one card per repository and one line of text per link. The owner can
 * remove a repository, change its kind, tick or untick roles, and add or remove a link. Every
 * change is saved; nothing here creates a coworker or a Box.
 */
export function DesktopIntakeGithubProjects({ github, intake }: {
    github: DesktopIntakeGithubController
    intake: { restored: boolean; finished: boolean; locked?: boolean }
}) {
    const [draft, setDraft] = useState<{ from: string; to: string; kind: DesktopGithubLinkKind }>({ from: '', to: '', kind: 'depends-on' })
    const record = github.record
    // Cards slide in only for a read the person watched here; a saved intake reopened shows them settled.
    const readHere = useRef(false)
    if (github.reading) readHere.current = true
    if (intake.finished || !intake.restored) return null
    if (!record) {
        if (!github.reading) return null
        return <section data-intake-github-projects aria-label="Read from GitHub" className={`${DISCOVERY_CARD_CLASS} pointer-events-auto mx-auto max-w-[22rem] text-left`}>
            <p role="status" className="text-xs text-muted-foreground">Reading {github.count === 1 ? 'your repository' : `${github.count} repositories`} from GitHub…</p>
        </section>
    }
    const disabled = github.reading || !!intake.locked
    const shown = record.projects.filter(project => !project.removed)
    if (!shown.length) return null
    const linkable = shown.filter(project => project.state === 'read')
    const from = linkable.some(project => project.id === draft.from) ? draft.from : linkable[0]?.id ?? ''
    const to = linkable.some(project => project.id === draft.to) && draft.to !== from ? draft.to : linkable.find(project => project.id !== from)?.id ?? ''
    const exists = record.links.some(link => link.from === from && link.to === to && link.kind === draft.kind)
    return (
        <section data-intake-github-projects aria-label="Read from GitHub" className="pointer-events-auto mx-auto max-w-[22rem] space-y-2 text-left">
            <div className="flex items-center gap-2 px-1">
                <Icon icon={BoxIcon} size="xs" />
                <span className="text-[11px] font-medium text-muted-foreground">Read from GitHub</span>
                <button type="button" data-intake-github-again disabled={disabled} onClick={() => github.analyze(true)}
                    className="ml-auto text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50">{github.reading ? 'Reading…' : 'Read again'}</button>
            </div>
            {github.dirty && <p className="px-1 text-[10px] text-muted-foreground">The list in the field changed. Read it to update these cards.</p>}
            {record.inferenceNote && <p data-intake-github-note className="px-1 text-[10px] leading-relaxed text-muted-foreground">{record.inferenceNote}</p>}
            <ul className="space-y-2">
                {shown.map((project, index) => <ProjectCard key={project.id} project={project} disabled={disabled} github={github} live={readHere.current} order={index} />)}
            </ul>
            {linkable.length > 1 && <div className={`${DISCOVERY_CARD_CLASS} text-left`}>
                <p className="text-[10px] font-medium text-muted-foreground">How the projects relate</p>
                {record.links.length === 0 && <p className="mt-1 text-xs text-muted-foreground">No link was found between these projects.</p>}
                <ul data-intake-github-link-list className="mt-1 space-y-1">
                    {record.links.map(link => (
                        <li key={`${link.from}>${link.to}:${link.kind}`} className="flex items-start gap-1.5 text-xs leading-relaxed" title={link.quote ?? undefined}>
                            <span className="min-w-0 flex-1">{githubProjectLinkLine(link, record.projects)}</span>
                            <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove link: ${githubProjectLinkLine(link, record.projects)}`}
                                disabled={disabled} onClick={() => github.edit({ type: 'remove-link', from: link.from, to: link.to, kind: link.kind })}><XIcon /></Button>
                        </li>
                    ))}
                </ul>
                <div data-intake-github-add-link className="mt-2 flex flex-wrap items-center gap-1">
                    <select aria-label="Link from" className={SELECT} value={from} disabled={disabled} onChange={event => setDraft(value => ({ ...value, from: event.target.value }))}>
                        {linkable.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select>
                    <select aria-label="Kind of link" className={SELECT} value={draft.kind} disabled={disabled} onChange={event => setDraft(value => ({ ...value, kind: event.target.value as DesktopGithubLinkKind }))}>
                        {DESKTOP_GITHUB_LINK_KINDS.map(kind => <option key={kind} value={kind}>{kind === 'depends-on' ? 'depends on' : 'pairs with'}</option>)}
                    </select>
                    <select aria-label="Link to" className={SELECT} value={to} disabled={disabled} onChange={event => setDraft(value => ({ ...value, to: event.target.value }))}>
                        {linkable.filter(project => project.id !== from).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select>
                    <Button type="button" size="sm" variant="outline" data-intake-github-link-add disabled={disabled || !from || !to || exists}
                        onClick={() => github.edit({ type: 'add-link', from, to, kind: draft.kind })}>Add link</Button>
                </div>
            </div>}
            {github.error && <p role="alert" className="px-1 text-xs text-destructive">{github.error}</p>}
            <p className="px-1 text-[10px] leading-relaxed text-muted-foreground/80">Your Chief of Staff proposes coworkers from this. Nothing is created until you approve the proposal, and no coworker gets GitHub access unless you assign it in the Vault.</p>
        </section>
    )
}
