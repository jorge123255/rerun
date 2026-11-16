'use client'

import { useState } from 'react'

import { Icon } from '@/components/ui/icon'
import type { DesktopIntakeGithubController } from '@/lib/desktop/foreman-intake/use-desktop-intake-github'
import { BoxIcon, ChevronDownIcon, ChevronUpIcon } from '@/lib/icons'
import { DesktopIntakeGithubProjects } from './intake/DesktopIntakeGithubProjects'

const REVIEW = { restored: true, finished: false } as const

/**
 * The GitHub projects of a conversation, above its message box: the repositories linked in its
 * messages, read by this Mac. One line says how many there are; opening it shows the same review
 * the intake has, where the owner removes a repository, changes its kind, roles and links.
 * Nothing is shown for a conversation with no projects.
 */
export function DesktopForemanGithubProjects({ github }: { github: DesktopIntakeGithubController }) {
    const [open, setOpen] = useState(false)
    const projects = github.record?.projects.filter(project => !project.removed) ?? []
    if (!projects.length) return null
    const read = projects.filter(project => project.state === 'read').length
    const label = read === projects.length
        ? `${read} GitHub ${read === 1 ? 'project' : 'projects'} read`
        : `${read} of ${projects.length} GitHub projects read`
    return (
        <section data-foreman-github-projects aria-label="GitHub projects" className="mx-3 mt-2 rounded-lg border bg-muted/30 text-xs">
            <button type="button" data-foreman-github-toggle aria-expanded={open} onClick={() => setOpen(value => !value)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Icon icon={BoxIcon} size="xs" />
                <span className="min-w-0 flex-1 truncate"><span className="font-medium">{label}</span><span className="text-muted-foreground"> · {projects.map(project => project.name).join(', ')}</span></span>
                <span className="shrink-0 text-muted-foreground">{open ? 'Hide' : 'Review'}</span>
                <Icon icon={open ? ChevronDownIcon : ChevronUpIcon} size="xs" />
            </button>
            {open && <div className="max-h-[40vh] overflow-y-auto border-t px-2 py-2">
                <DesktopIntakeGithubProjects github={github} intake={REVIEW} />
            </div>}
        </section>
    )
}
