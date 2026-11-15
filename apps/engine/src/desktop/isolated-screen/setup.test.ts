import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { bindIsolatedScreenSetup, buildImageArgs, guestSourceDir, parseBuildStep } from './setup.js'
import { GUEST_IMAGE } from './docker-args.js'
import type { DockerImage, DockerVersion } from './docker-cli.js'

const ok: DockerVersion = { kind: 'ok', os: 'linux', arch: 'arm64' }
function box(version: DockerVersion, image: DockerImage, result: { code: number | null; tail: string } = { code: 0, tail: '' }) {
    const state = { version, image, builds: [] as string[][], release: () => {}, lines: [] as string[] }
    const gate = new Promise<void>(resolve => { state.release = resolve })
    const setup = bindIsolatedScreenSetup({
        docker: { version: async () => state.version, image: async () => state.image },
        sourceDir: guestSourceDir(),
        build: async (args, signal, onLine) => {
            state.builds.push(args)
            for (const line of state.lines) onLine(line)
            await Promise.race([gate, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))])
            return result
        },
    })
    return { setup, state }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5))

describe('setting up the coworker screen', () => {
    it('names the one thing that is missing, in the order a person has to fix it', async () => {
        expect((await box({ kind: 'missing' }, { kind: 'missing' }).setup.status()).need).toBe('docker')
        expect((await box({ kind: 'unreachable' }, { kind: 'missing' }).setup.status()).need).toBe('docker-running')
        expect((await box(ok, { kind: 'missing' }).setup.status()).need).toBe('image')
        expect((await box(ok, { kind: 'present', architecture: 'amd64' }).setup.status()).need).toBe('image')
        expect((await box({ kind: 'ok', os: 'linux', arch: 'amd64' }, { kind: 'missing' }).setup.status()).need).toBe('unsupported')
        expect(await box(ok, { kind: 'present', architecture: 'arm64' }).setup.status()).toEqual({ need: 'nothing', install: { state: 'idle', step: null, steps: null, error: null } })
    })

    it('builds the image from the files the app ships with, once, and only when asked', async () => {
        expect(existsSync(join(guestSourceDir(), 'Dockerfile'))).toBe(true)
        const { setup, state } = box(ok, { kind: 'missing' })
        state.lines = ['#5 [2/9] RUN apt-get update', 'not a step', '#6 [3/9] RUN install']
        await setup.status()
        expect(state.builds).toEqual([])
        const started = await setup.action({ action: 'install' })
        expect(started.install).toEqual({ state: 'installing', step: 3, steps: 9, error: null })
        await setup.action({ action: 'install' })
        expect(state.builds).toHaveLength(1)
        expect(state.builds[0]).toEqual(buildImageArgs(guestSourceDir()))
        expect(state.builds[0]).toContain(GUEST_IMAGE)
        state.image = { kind: 'present', architecture: 'arm64' }
        state.release(); await settle()
        expect(await setup.status()).toEqual({ need: 'nothing', install: { state: 'idle', step: null, steps: null, error: null } })
    })

    it('will not build when Docker is missing or stopped, or the image is already there', async () => {
        for (const [version, image] of [[{ kind: 'missing' }, { kind: 'missing' }], [{ kind: 'unreachable' }, { kind: 'missing' }], [ok, { kind: 'present', architecture: 'arm64' }]] as Array<[DockerVersion, DockerImage]>) {
            const { setup, state } = box(version, image)
            await setup.action({ action: 'install' })
            expect(state.builds).toEqual([])
        }
    })

    it('says a failed download apart from a failed build, and lets the person try again', async () => {
        const offline = box(ok, { kind: 'missing' }, { code: 1, tail: 'failed to do request: dial tcp: lookup registry-1.docker.io: no such host' })
        await offline.setup.action({ action: 'install' }); offline.state.release(); await settle()
        expect((await offline.setup.status()).install).toMatchObject({ state: 'failed', error: 'offline' })
        const broken = box(ok, { kind: 'missing' }, { code: 1, tail: 'E: Unable to locate package' })
        await broken.setup.action({ action: 'install' }); broken.state.release(); await settle()
        expect((await broken.setup.status()).install).toMatchObject({ state: 'failed', error: 'build' })
        await broken.setup.action({ action: 'install' })
        expect(broken.state.builds).toHaveLength(2)
    })

    it('stops the build on cancel and when the app closes, without calling it a failure', async () => {
        const { setup } = box(ok, { kind: 'missing' })
        await setup.action({ action: 'install' })
        expect((await setup.action({ action: 'cancel' })).install).toEqual({ state: 'idle', step: null, steps: null, error: null })
        await setup.action({ action: 'install' })
        setup.stop(); await settle()
        expect((await setup.status()).install.state).toBe('idle')
    })

    it('reads progress only from Docker’s own step lines', () => {
        expect(parseBuildStep('#7 [ 4/12] RUN apt-get install')).toEqual({ step: 4, steps: 12 })
        expect(parseBuildStep('#7 0.512 Get:1 http://deb.debian.org')).toBeNull()
        expect(parseBuildStep('#7 [13/12] RUN x')).toBeNull()
    })
})
