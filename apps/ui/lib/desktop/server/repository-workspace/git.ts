import 'server-only'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

// This Mac's own git and GitHub command line, run by the app for a coworker's working copy.
//
// The sign-in they use is the person's own, kept where git and gh keep it. The app never reads it:
// it only starts the two programs. Everything a repository could use to make git run something on
// the Mac is switched off for every call: hooks, the file monitor, submodules, local-file remotes and the pager. Large-file downloads are skipped.

export type CommandResult = { code: number; stdout: string; stderr: string; cut: boolean }
export type CommandOptions = { cwd?: string; timeoutMs: number; maxOutput?: number; input?: string; signal?: AbortSignal }
export type Command = (args: readonly string[], options: CommandOptions) => Promise<CommandResult>

const SAFE = [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'core.editor=true', '-c', 'core.askPass=',
    '-c', 'credential.interactive=false', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false',
    '-c', 'gc.auto=0', '-c', 'advice.detachedHead=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false',
    '-c', 'core.symlinks=false', '-c', 'core.quotePath=false',
] as const

function environment(): NodeJS.ProcessEnv {
    const env: Record<string, string> = {
        HOME: process.env.HOME || homedir(), PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
        GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1',
        // A Mac whose git reaches GitHub over SSH uses the person's own key, and is never left waiting on a question.
        GIT_SSH_COMMAND: '/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=20',
        ...(process.env.SSH_AUTH_SOCK && { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }),
        ...(process.env.USER && { USER: process.env.USER }), ...(process.env.TMPDIR && { TMPDIR: process.env.TMPDIR }),
    }
    return env as NodeJS.ProcessEnv
}

function run(binary: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
    const max = options.maxOutput ?? 2_000_000
    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error('Cancelled.')); return }
        const child = spawn(binary, [...args], { cwd: options.cwd, env: environment(), stdio: ['pipe', 'pipe', 'pipe'], detached: true })
        let stdout = '', stderr = '', cut = false, settled = false
        const stop = () => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ } }
        const timer = setTimeout(() => { stop(); finish(new Error('This took too long.')) }, options.timeoutMs)
        const aborted = () => { stop(); finish(new Error('Cancelled.')) }
        options.signal?.addEventListener('abort', aborted, { once: true })
        function finish(error: Error | null, code = 1) {
            if (settled) return
            settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', aborted)
            if (error) reject(error); else resolve({ code, stdout, stderr, cut })
        }
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => { if (stdout.length < max) stdout += chunk.slice(0, max - stdout.length); else cut = true; if (stdout.length >= max) cut = true })
        child.stderr.on('data', (chunk: string) => { if (stderr.length < 20_000) stderr += chunk.slice(0, 20_000 - stderr.length) })
        child.on('error', () => finish(new Error('The program could not be started.')))
        child.on('close', code => finish(null, code ?? 1))
        child.stdin.on('error', () => {})
        child.stdin.end(options.input ?? '')
    })
}

const GIT = '/usr/bin/git'
export const hostGit: Command = (args, options) => run(GIT, [...SAFE, ...args], options)
/** For tests only: the same git with a folder allowed as the remote, so no network is needed. */
export const fixtureGit: Command = (args, options) => run(GIT, [...SAFE.map(value => value === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : value), ...args], options)

const GH_PLACES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'] as const
export const hostGhPath = (): string | null => GH_PLACES.find(place => existsSync(place)) ?? null
/** Null when the GitHub command line is not installed on this Mac. */
export const hostGh: Command | null = (() => {
    const command: Command = (args, options) => { const binary = hostGhPath(); return binary ? run(binary, args, options) : Promise.reject(new Error('The GitHub command line is not installed.')) }
    return command
})()

/** Words a git or gh failure is told to the coworker in. Nothing from the program's own output is passed on except a known cause. */
export function commandFailure(result: CommandResult, doing: string): string {
    const said = `${result.stderr}\n${result.stdout}`.toLowerCase()
    if (/could not read username|authentication failed|terminal prompts disabled|gh auth login|not logged in|http 401|bad credentials|permission denied \(publickey|could not read from remote repository/.test(said)) return `${doing} failed: this Mac is not signed in to GitHub for this repository. Tell the user to run "gh auth login" in Terminal on this Mac, then try again.`
    if (/repository not found|http 404|not found/.test(said)) return `${doing} failed: GitHub does not show this repository to this Mac's sign-in. Tell the user to check the repository name in Edit coworker and that their GitHub account can open it.`
    if (/could not resolve host|failed to connect|network is unreachable|timed out/.test(said)) return `${doing} failed: GitHub could not be reached from this Mac. Try again later.`
    if (/http 403|rate limit/.test(said)) return `${doing} failed: GitHub refused this for now (a limit or a permission). Try again later.`
    return `${doing} failed.`
}

/**
 * One GET of GitHub's API with this Mac's own GitHub command line, answered with GitHub's status
 * and data. For the app's own reading of a repository the person listed. Only a path under
 * /repos/ is ever asked for, and nothing is sent but the request itself.
 */
export async function hostGithubGet(path: string, signal: AbortSignal, gh: Command | null = hostGhPath() ? hostGh : null): Promise<{ status: number; data: unknown } | null> {
    if (!gh || !/^\/repos\/[A-Za-z0-9._~%\/-]+$/.test(path) || path.split('/').some(part => part === '.' || part === '..')) return null
    const answered = await gh(['api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', path], { timeoutMs: 20_000, maxOutput: 2_000_000, signal })
    let data: unknown = null
    try { data = JSON.parse(answered.stdout) } catch { /* no body */ }
    if (answered.code === 0) return { status: 200, data }
    // gh says the status on its error line; anything else is a failure to ask at all.
    const status = Number(/\(HTTP (\d{3})\)/.exec(answered.stderr)?.[1] ?? 0)
    return status >= 400 && status <= 599 ? { status, data } : null
}
