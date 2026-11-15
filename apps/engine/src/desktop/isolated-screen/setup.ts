import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DesktopScreenSetup, DesktopScreenSetupAction } from '@rerun/contracts'
import { GUEST_IMAGE, GUEST_PLATFORM, isArm64 } from './docker-args.js'
import type { DockerClient } from './docker-cli.js'

/**
 * Setting up the coworker screen for this Mac: says which of Docker, a running Docker, and the
 * screen image is missing, and builds the image on request.
 *
 * Nothing here starts on its own. Docker is opened by the person; the build runs only after they
 * ask for it, from the files the app ships with, and stops with the app.
 */
const DOCKER_APP_BIN = '/Applications/Docker.app/Contents/Resources/bin'
const BUILD_LIMIT_MS = 25 * 60_000
// "#7 [3/9] RUN apt-get ..." in docker's plain progress.
const STEP = /^#\d+ \[\s*(\d+)\/(\d+)\]/

export function guestSourceDir(): string {
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'desktop-guest')
}

export function buildImageArgs(dir: string): string[] {
    return ['build', '--progress=plain', '--platform', GUEST_PLATFORM, '-t', GUEST_IMAGE, '-f', join(dir, 'Dockerfile'), dir]
}

export function parseBuildStep(line: string): { step: number; steps: number } | null {
    const match = STEP.exec(line)
    if (!match) return null
    const step = Number(match[1]), steps = Number(match[2])
    return step >= 0 && steps >= 1 && step <= steps ? { step, steps } : null
}

type Build = (args: string[], signal: AbortSignal, onLine: (line: string) => void) => Promise<{ code: number | null; tail: string }>

function dockerBuild(args: string[], signal: AbortSignal, onLine: (line: string) => void): Promise<{ code: number | null; tail: string }> {
    const executable = existsSync(join(DOCKER_APP_BIN, 'docker')) ? join(DOCKER_APP_BIN, 'docker') : 'docker'
    return new Promise((resolve, reject) => {
        // Docker's own folder is on the path so its sign-in helper and build plugin are found: the
        // app starts the engine with a bare system path.
        const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PATH: `${DOCKER_APP_BIN}:${process.env.PATH ?? '/usr/bin:/bin'}` } })
        let rest = '', tail = ''
        const stop = () => child.kill('SIGTERM')
        signal.addEventListener('abort', stop, { once: true })
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk: string) => {
            const lines = (rest + chunk).split('\n')
            rest = lines.pop() ?? ''
            for (const line of lines) { onLine(line); tail = (tail + line + '\n').slice(-4000) }
        })
        child.once('error', error => { signal.removeEventListener('abort', stop); reject(error) })
        child.once('close', code => { signal.removeEventListener('abort', stop); resolve({ code, tail }) })
    })
}

export function bindIsolatedScreenSetup(deps: { docker: Pick<DockerClient, 'version' | 'image'>; build?: Build; sourceDir?: string }) {
    const build = deps.build ?? dockerBuild
    const sourceDir = deps.sourceDir ?? guestSourceDir()
    let job: { controller: AbortController; step: number | null; steps: number | null } | null = null
    let error: DesktopScreenSetup['install']['error'] = null

    async function need(): Promise<DesktopScreenSetup['need']> {
        const signal = AbortSignal.timeout(15_000)
        const version = await deps.docker.version(signal).catch(() => ({ kind: 'unreachable' as const }))
        if (version.kind === 'missing') return 'docker'
        if (version.kind === 'unreachable') return 'docker-running'
        if (version.os !== 'linux' || !isArm64(version.arch)) return 'unsupported'
        const image = await deps.docker.image(signal).catch(() => ({ kind: 'unreachable' as const }))
        if (image.kind === 'unreachable') return 'docker-running'
        if (image.kind === 'missing') return 'image'
        return isArm64(image.architecture) ? 'nothing' : 'image'
    }

    async function status(): Promise<DesktopScreenSetup> {
        const needs = await need()
        if (needs === 'nothing') error = null
        return { need: needs, install: job ? { state: 'installing', step: job.step, steps: job.steps, error: null } : { state: error ? 'failed' : 'idle', step: null, steps: null, error } }
    }

    function begin(): void {
        const current = { controller: new AbortController(), step: null as number | null, steps: null as number | null }
        job = current
        error = null
        const signal = AbortSignal.any([current.controller.signal, AbortSignal.timeout(BUILD_LIMIT_MS)])
        void build(buildImageArgs(sourceDir), signal, line => {
            const at = parseBuildStep(line)
            if (at) { current.step = at.step; current.steps = at.steps }
        }).then(result => {
            if (current.controller.signal.aborted) return
            if (result.code !== 0) error = /could not resolve|network|timeout|no such host|TLS handshake|connection refused/i.test(result.tail) ? 'offline' : 'build'
        }, () => { if (!current.controller.signal.aborted) error = 'docker' }).finally(() => { if (job === current) job = null })
    }

    return {
        status,
        async action(input: DesktopScreenSetupAction): Promise<DesktopScreenSetup> {
            if (input.action === 'cancel') { job?.controller.abort(); job = null; return status() }
            // One build at a time, and only when the image is the thing that is missing.
            if (!job && await need() === 'image' && existsSync(join(sourceDir, 'Dockerfile'))) begin()
            else if (!job && !existsSync(join(sourceDir, 'Dockerfile'))) error = 'build'
            return status()
        },
        stop(): void { job?.controller.abort(); job = null },
    }
}
