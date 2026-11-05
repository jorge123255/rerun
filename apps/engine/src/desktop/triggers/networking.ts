import {
    desktopTriggerIngressOriginSchema,
    type DesktopTriggerIngressOrigin,
} from '@rerun/contracts'

export type DesktopTriggerNetworking = {
    origin(): DesktopTriggerIngressOrigin
    /** Default disabled. Never opens a port, tunnel, firewall rule or remote call from this lane. */
    start(opts?: { confirmHosting?: boolean }): Promise<{ started: boolean; reason: string; origin: DesktopTriggerIngressOrigin }>
    stop(): Promise<{ stopped: boolean }>
}

const DISABLED: DesktopTriggerIngressOrigin = {
    enabled: false,
    origin: null,
    bindHost: '127.0.0.1',
    bindPort: null,
    hostingDecision: 'unresolved',
}

/**
 * Root injects a concrete origin/start/stop later. This default stays fail-closed and loopback-only.
 * External delivery still requires an explicit hosting decision outside this lane.
 */
export function createDisabledDesktopTriggerNetworking(
    seed: Partial<DesktopTriggerIngressOrigin> = {},
): DesktopTriggerNetworking {
    let current = desktopTriggerIngressOriginSchema.parse({ ...DISABLED, ...seed, enabled: false })
    return {
        origin: () => current,
        async start(opts) {
            if (!opts?.confirmHosting) {
                return {
                    started: false,
                    reason: 'Hosting decision unresolved — ingress remains unmounted and disabled (loopback default only).',
                    origin: current,
                }
            }
            // Even with confirmHosting, this lane refuses to bind sockets. Root must supply a real listener.
            current = desktopTriggerIngressOriginSchema.parse({
                ...current,
                enabled: false,
                hostingDecision: 'external-pending-root',
            })
            return {
                started: false,
                reason: 'Root must mount the constructed ingress handler after choosing a hosting path. No listener was started.',
                origin: current,
            }
        },
        async stop() {
            current = { ...current, enabled: false }
            return { stopped: true }
        },
    }
}

export function createDesktopTriggerNetworkingFromOrigin(
    origin: DesktopTriggerIngressOrigin,
    hooks: { start?: DesktopTriggerNetworking['start']; stop?: DesktopTriggerNetworking['stop'] } = {},
): DesktopTriggerNetworking {
    let current = desktopTriggerIngressOriginSchema.parse(origin)
    const disabled = createDisabledDesktopTriggerNetworking(current)
    return {
        origin: () => current,
        start: hooks.start ?? disabled.start,
        stop: hooks.stop ?? (async () => {
            current = { ...current, enabled: false }
            return { stopped: true }
        }),
    }
}
