import { containerLabels, containerName, volumeLabels, volumeName, assertContainerName, assertVolumeName } from './identity.js'
import { IsolatedScreenRefusal } from './refusal.js'
import type { ScreenOwner } from './types.js'

export const GUEST_IMAGE = 'rerun-desktop-guest:round33'
export const GUEST_PLATFORM = 'linux/arm64'

const BANNED_EXACT = new Set(['--privileged', '--pid=host', '--network=host', '--network', '--publish', '-p', '-v', '--volume', '--platform', 'pull'])
const BANNED_PART = ['docker.sock', '/Users/', '/Volumes/', '/private/var', 'Application Support', '.ssh', '.aws', '.gnupg', 'Keychains', 'type=bind']
const TMPFS = ['/tmp:', '/run:', '/home/rerun:', '/dev/shm:']
const MOUNT = /^type=volume,source=rerun-screen-profile-[a-f0-9]{32},destination=\/var\/lib\/rerun\/profile$/

export function isArm64(arch: string): boolean {
    return arch === 'arm64' || arch === 'aarch64'
}

export function assertSafeRunArgs(args: readonly string[]): void {
    const mounts = args.filter(arg => arg.startsWith('type=volume,'))
    if (mounts.length !== 1 || !MOUNT.test(mounts[0] ?? '')) throw new IsolatedScreenRefusal('Refusing a host mount.', 'refused')
    if (args[args.length - 1] !== GUEST_IMAGE) throw new IsolatedScreenRefusal('Refusing a host mount.', 'refused')
    for (const arg of args) {
        if (BANNED_EXACT.has(arg) || BANNED_PART.some(banned => arg.includes(banned))) throw new IsolatedScreenRefusal('Refusing a host mount.', 'refused')
        if (arg.startsWith('/') && !TMPFS.some(prefix => arg.startsWith(prefix))) throw new IsolatedScreenRefusal('Refusing a host mount.', 'refused')
    }
}

function labelArgs(labels: Record<string, string>): string[] {
    const args: string[] = []
    for (const [key, value] of Object.entries(labels)) {
        if (!/^com\.rerun\.[A-Za-z0-9.]+$/.test(key) || /[\r\n\0]/.test(value)) throw new IsolatedScreenRefusal('Refusing a Docker label.', 'refused')
        args.push('--label', `${key}=${value}`)
    }
    return args
}

// No published port: watch uses the guest's view-only VNC server through docker exec.
export function containerRunArgs(owner: ScreenOwner, generation: string): string[] {
    const name = containerName(owner.engineAgentId)
    const volume = volumeName(owner.engineAgentId)
    assertContainerName(name)
    assertVolumeName(volume)
    const args = [
        'run', '-d',
        '--name', name,
        '--restart=no',
        '--init',
        '--memory=2g',
        '--memory-swap=2g',
        '--cpus=2',
        '--pids-limit=512',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--read-only',
        '--user=10001:10001',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
        '--tmpfs', '/run:rw,nosuid,nodev,size=32m,uid=10001,gid=10001,mode=700',
        '--tmpfs', '/home/rerun:rw,nosuid,nodev,size=32m,uid=10001,gid=10001,mode=700',
        '--tmpfs', '/dev/shm:rw,nosuid,nodev,size=256m',
        ...labelArgs(containerLabels(owner, generation)),
        '--mount', `type=volume,source=${volume},destination=/var/lib/rerun/profile`,
        GUEST_IMAGE,
    ]
    assertSafeRunArgs(args)
    return args
}

export function volumeCreateArgs(owner: ScreenOwner): string[] {
    const name = volumeName(owner.engineAgentId)
    assertVolumeName(name)
    return ['volume', 'create', ...labelArgs(volumeLabels(owner)), name]
}

export function removeContainerArgs(name: string): string[] {
    if (!/^[a-f0-9]{64}$/.test(name)) assertContainerName(name)
    return ['rm', '-f', '--', name]
}

export function removeVolumeArgs(name: string): string[] {
    assertVolumeName(name)
    return ['volume', 'rm', '--', name]
}

export const VERSION_ARGS = ['version', '--format', '{{.Server.Os}} {{.Server.Arch}}'] as const

export function imageInspectArgs(): string[] {
    return ['image', 'inspect', '--format', '{{.Architecture}}', GUEST_IMAGE]
}

export function inspectContainerArgs(name: string): string[] {
    assertContainerName(name)
    return ['inspect', '--format', '{{.State.Status}}\t{{json .Config.Labels}}\t{{.Id}}', '--', name]
}

export function inspectVolumeArgs(name: string): string[] {
    assertVolumeName(name)
    return ['volume', 'inspect', '--format', '{{json .Labels}}', name]
}

export const LIST_SCREEN_ARGS = [
    'ps', '-a',
    '--filter', 'label=com.rerun.desktop.role=isolated-screen',
    '--format', '{{.Names}}\t{{.Label "com.rerun.engineAgentId"}}\t{{.Label "com.rerun.launchNonce"}}\t{{.Label "com.rerun.sessionGeneration"}}\t{{.Label "com.rerun.desktop.managed"}}\t{{.State}}',
] as const

export function assertGuestCommand(command: readonly string[]): void {
    const rpc = command.length === 1 && command[0] === 'rerun-rpc'
    const vnc = command.length === 2 && command[0] === 'rerun-vnc' && (command[1] === 'watch' || command[1] === 'drive')
    if (!rpc && !vnc) throw new IsolatedScreenRefusal('That screen action is not available.', 'refused')
}

export function execArgs(name: string, command: readonly string[]): string[] {
    assertContainerName(name)
    assertGuestCommand(command)
    return ['exec', '-i', '--', name, ...command]
}
