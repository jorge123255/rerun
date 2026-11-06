import 'server-only'
import type { DesktopMcpResolvedMaterial } from './resolve'

export type DesktopMcpMaterialLease = {
    configured: boolean
    material: DesktopMcpResolvedMaterial
    check(): Promise<void>
    protect<T>(value: T): T
    release(): Promise<void>
}
export type DesktopMcpMaterialSource = (owner: string, name: string, revision: string, phase: 'discovery' | 'invocation', signal: AbortSignal, acquisitionSignal?: AbortSignal) => Promise<DesktopMcpMaterialLease>

export const emptyMcpMaterialLease = (): DesktopMcpMaterialLease => ({
    configured: false, material: { args: [], env: {}, headers: {}, inheritEnv: false }, check: async () => {}, protect: value => value, release: async () => {},
})
