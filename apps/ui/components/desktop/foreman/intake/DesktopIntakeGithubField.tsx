'use client'

import { useId } from 'react'
import { DESKTOP_GITHUB_PROJECT_LIMITS } from '@rerun/contracts'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { DesktopIntakeGithubController } from '@/lib/desktop/foreman-intake/use-desktop-intake-github'

/**
 * The second way to answer the first question: the software projects the person works on, as
 * GitHub repository links. It sits under the website field and changes nothing about it; either
 * or both may be filled.
 */
export function DesktopIntakeGithubField({ github, disabled }: { github: DesktopIntakeGithubController; disabled?: boolean }) {
    const id = useId()
    if (!github.open) return (
        <button type="button" data-intake-github-toggle disabled={disabled} onClick={() => github.setOpen(true)}
            className="mt-2 text-left text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50">
            I’m working on software: add GitHub projects
        </button>
    )
    const problem = github.error ?? github.refusal ?? github.message
    return (
        <div data-intake-github-field className="mt-3 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
                <label htmlFor={id} className="text-xs font-medium">GitHub repositories</label>
                <button type="button" data-intake-github-toggle disabled={disabled} onClick={() => github.setOpen(false)}
                    className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50">Hide</button>
            </div>
            <textarea
                id={id}
                data-intake-github-links
                rows={3}
                value={github.text}
                disabled={disabled}
                maxLength={DESKTOP_GITHUB_PROJECT_LIMITS.maxInput}
                spellCheck={false}
                aria-invalid={github.refusal ? true : undefined}
                aria-describedby={`${id}-help${problem ? ` ${id}-problem` : ''}`}
                placeholder={'https://github.com/owner/name\nhttps://github.com/owner/another'}
                onChange={event => github.setText(event.target.value)}
                // Typing here must not answer the card: Enter starts a new line, digits stay digits.
                onClick={event => event.stopPropagation()}
                onKeyDown={event => event.stopPropagation()}
                className="max-h-32 min-h-16 w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            />
            <p id={`${id}-help`} className="text-[11px] leading-relaxed text-muted-foreground">
                One link per line, up to {DESKTOP_GITHUB_PROJECT_LIMITS.maxRepositories}. Public repositories are read as data (description, file list, README and package files). Nothing is cloned or run.
            </p>
            {problem && <p id={`${id}-problem`} role="alert" className="text-xs text-destructive">{problem}</p>}
            <Button type="button" size="sm" variant="outline" data-intake-github-read disabled={disabled || github.reading || github.count === 0 || !github.dirty}
                onClick={() => github.analyze()}>
                {github.reading && <Spinner className="text-muted-foreground" />}
                {github.reading ? 'Reading GitHub…' : github.count === 0 ? 'Read repositories' : !github.dirty ? 'Read from GitHub' : `Read ${github.count} ${github.count === 1 ? 'repository' : 'repositories'}`}
            </Button>
        </div>
    )
}
