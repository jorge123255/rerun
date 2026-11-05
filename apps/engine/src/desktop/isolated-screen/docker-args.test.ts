import { describe, expect, it } from 'vitest'
import { GUEST_IMAGE, GUEST_PLATFORM, assertGuestCommand, assertSafeRunArgs, containerRunArgs, execArgs, imageInspectArgs, isArm64, removeContainerArgs, removeVolumeArgs, volumeCreateArgs } from './docker-args.js'
import { containerName, volumeName } from './identity.js'
import { IsolatedScreenRefusal } from './refusal.js'

const owner = { engineAgentId: 'coworker1', launchNonce: '11111111-1111-4111-8111-111111111111' }
const generation = 'ab'.repeat(16)

describe('guest run arguments', () => {
    it('starts a bounded arm64 guest with only the profile volume', () => {
        const args = containerRunArgs(owner, generation)
        expect(GUEST_PLATFORM).toBe('linux/arm64')
        expect(args[0]).toBe('run')
        expect(args.at(-1)).toBe(GUEST_IMAGE)
        expect(args).toEqual(expect.arrayContaining([
            '--name', containerName(owner.engineAgentId),
            '--restart=no', '--init', '--memory=2g', '--memory-swap=2g', '--cpus=2', '--pids-limit=512',
            '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only',
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
            '--tmpfs', '/dev/shm:rw,nosuid,nodev,size=256m',
            `type=volume,source=${volumeName(owner.engineAgentId)},destination=/var/lib/rerun/profile`,
        ]))
        const text = args.join('\n')
        for (const banned of ['docker.sock', '/Users/', '/Volumes/', '/private/var', 'Application Support', '.ssh', 'Keychains', 'type=bind']) {
            expect(text).not.toContain(banned)
        }
        for (const flag of ['--privileged', '--network', '--network=host', '--pid=host', '--publish', '-p', '-v', '--volume', '--platform', 'pull']) {
            expect(args).not.toContain(flag)
        }
    })

    it('refuses a bind mount or a published port before docker is asked', () => {
        const args = containerRunArgs(owner, generation)
        const mounted = [...args]
        mounted.splice(mounted.length - 1, 0, 'type=bind,source=/Users/me,destination=/tmp')
        expect(() => assertSafeRunArgs(mounted)).toThrow(IsolatedScreenRefusal)
        const published = [...args]
        published.splice(1, 0, '-p', '5900:5900')
        expect(() => assertSafeRunArgs(published)).toThrow(/host mount/)
    })

    it('creates and removes only exact screen names', () => {
        expect(volumeCreateArgs(owner).slice(0, 2)).toEqual(['volume', 'create'])
        expect(volumeCreateArgs(owner).join('\n')).not.toContain(owner.launchNonce)
        expect(removeContainerArgs(containerName(owner.engineAgentId))).toEqual(['rm', '-f', '--', containerName(owner.engineAgentId)])
        expect(removeVolumeArgs(volumeName(owner.engineAgentId))[0]).toBe('volume')
        expect(() => removeContainerArgs('postgres')).toThrow(IsolatedScreenRefusal)
        expect(imageInspectArgs()).toEqual(['image', 'inspect', '--format', '{{.Architecture}}', GUEST_IMAGE])
        expect(execArgs(containerName(owner.engineAgentId), ['rerun-vnc', 'watch']).slice(0, 4)).toEqual(['exec', '-i', '--', containerName(owner.engineAgentId)])
        expect(() => assertGuestCommand(['rerun-vnc', 'control'])).toThrow(/not available/)
        expect(() => assertGuestCommand(['sh'])).toThrow(IsolatedScreenRefusal)
        expect(isArm64('arm64')).toBe(true)
        expect(isArm64('aarch64')).toBe(true)
        expect(isArm64('amd64')).toBe(false)
    })
})
