import { createHash } from 'node:crypto'
import { IsolatedScreenRefusal } from './refusal.ts'
import type { ScreenOwner, ScreenTarget } from './types.ts'

export const LABEL_ROLE = 'com.rerun.desktop.role'
export const LABEL_MANAGED = 'com.rerun.desktop.managed'
export const LABEL_AGENT = 'com.rerun.engineAgentId'
export const LABEL_NONCE = 'com.rerun.launchNonce'
export const LABEL_GENERATION = 'com.rerun.sessionGeneration'
export const ROLE_SCREEN = 'isolated-screen'
export const ROLE_PROFILE = 'screen-profile'

const AGENT_ID = /^[A-Za-z0-9._:-]{1,128}$/
const CONTAINER_NAME = /^rerun-screen-[a-f0-9]{32}$/
const VOLUME_NAME = /^rerun-screen-profile-[a-f0-9]{32}$/

export function assertAgentId(engineAgentId: string): void {
    if (typeof engineAgentId !== 'string' || !AGENT_ID.test(engineAgentId) || engineAgentId.includes('..')) {
        throw new IsolatedScreenRefusal('The screen owner is not valid.', 'refused')
    }
}

export function assertLaunchNonce(launchNonce: string): void {
    if (typeof launchNonce !== 'string' || !AGENT_ID.test(launchNonce) || launchNonce.includes('..')) {
        throw new IsolatedScreenRefusal('The screen owner is not valid.', 'refused')
    }
}

export function assertOwner(owner: ScreenOwner): void {
    assertAgentId(owner.engineAgentId)
    assertLaunchNonce(owner.launchNonce)
}

export function assertTarget(target: ScreenTarget): void {
    assertOwner(target)
    if (typeof target.sessionGeneration !== 'string' || !/^[a-f0-9]{32}$/.test(target.sessionGeneration)) {
        throw new IsolatedScreenRefusal('This screen session is no longer current.', 'stale')
    }
}

export function screenKey(engineAgentId: string): string {
    assertAgentId(engineAgentId)
    return createHash('sha256').update(engineAgentId, 'utf8').digest('hex').slice(0, 32)
}

export function containerName(engineAgentId: string): string {
    return `rerun-screen-${screenKey(engineAgentId)}`
}

export function volumeName(engineAgentId: string): string {
    return `rerun-screen-profile-${screenKey(engineAgentId)}`
}

export function assertContainerName(name: string): void {
    if (!CONTAINER_NAME.test(name)) throw new IsolatedScreenRefusal('The screen owner is not valid.', 'refused')
}

export function assertVolumeName(name: string): void {
    if (!VOLUME_NAME.test(name)) throw new IsolatedScreenRefusal('The screen owner is not valid.', 'refused')
}

export function sameOwnerContainer(labels: Record<string, string>, owner: ScreenOwner): boolean {
    return labels[LABEL_ROLE] === ROLE_SCREEN
        && labels[LABEL_MANAGED] === '1'
        && labels[LABEL_AGENT] === owner.engineAgentId
        && typeof labels[LABEL_NONCE] === 'string'
        && AGENT_ID.test(labels[LABEL_NONCE])
        && typeof labels[LABEL_GENERATION] === 'string'
        && /^[a-f0-9]{32}$/.test(labels[LABEL_GENERATION])
}

export function sameOwnerVolume(labels: Record<string, string>, owner: ScreenOwner): boolean {
    return labels[LABEL_ROLE] === ROLE_PROFILE && labels[LABEL_MANAGED] === '1' && labels[LABEL_AGENT] === owner.engineAgentId
}

export function containerLabels(owner: ScreenOwner, generation: string): Record<string, string> {
    return {
        [LABEL_ROLE]: ROLE_SCREEN,
        [LABEL_MANAGED]: '1',
        [LABEL_AGENT]: owner.engineAgentId,
        [LABEL_NONCE]: owner.launchNonce,
        [LABEL_GENERATION]: generation,
    }
}

export function volumeLabels(owner: ScreenOwner): Record<string, string> {
    return {
        [LABEL_ROLE]: ROLE_PROFILE,
        [LABEL_MANAGED]: '1',
        [LABEL_AGENT]: owner.engineAgentId,
    }
}
