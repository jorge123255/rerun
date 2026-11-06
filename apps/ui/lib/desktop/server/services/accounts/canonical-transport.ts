import 'server-only'
import type { LocalServices, ServiceRun, ServiceTransport } from '../lifecycle'
import type { ServiceInstall } from '../store'
import type { HeaderSecretPort } from './secret-store'
import { bundlesMatch, type HeaderSecretBundle } from './header-secret-codec'
import { accountTransport, type AccountNetwork } from './transport'
import type { AccountCompilePlan } from './compiler'

/** The existing service bridge supplies the authenticated, exact run identity. */
export function canonicalAccountTransport(services: LocalServices, secrets: HeaderSecretPort, network: AccountNetwork = fetch) {
    const http = accountTransport(network)
    return (record: ServiceInstall, run: ServiceRun | undefined, parent: AbortSignal): ServiceTransport => {
        const plan = record.plan as AccountCompilePlan
        if (!['anonymous', 'bearer', 'headers'].includes(plan.shape)) throw new Error('Invalid service account plan')
        const identity = (owner: string, name: string, revision: string) => {
            if (owner !== record.owner || name !== services.idName(record) || revision !== record.revision) throw new Error('Service account identity changed')
        }
        async function current(signal: AbortSignal) {
            const authority = await services.current(record.owner, 'use', run, signal)
            if (authority.engineAgentId !== record.engineId) throw new Error('Service account owner changed')
            const now = await services.liveRecord(record.owner, record.key, record.revision, signal)
            if (now.id !== record.id || now.engineId !== record.engineId || JSON.stringify(now.plan) !== JSON.stringify(record.plan)) throw new Error('Service account changed')
            return authority
        }
        const readBundle = () => plan.shape === 'anonymous'
            ? Promise.resolve<HeaderSecretBundle>({ headers: {}, inputs: {} })
            : secrets.read(record.owner, record.id, record.revision)
        const wipe = (bundle: HeaderSecretBundle | null) => {
            if (bundle) for (const values of [bundle.headers, bundle.inputs]) for (const key of Object.keys(values)) values[key] = ''
        }
        async function operate(owner: string, name: string, revision: string, call: { name: string; arguments: Record<string, unknown> } | undefined, stop?: AbortSignal) {
            identity(owner, name, revision)
            if (call && !run) throw new Error('Tool calls require a current chat run')
            const controller = new AbortController()
            const signal = AbortSignal.any([parent, ...(stop ? [stop] : []), controller.signal, AbortSignal.timeout(call ? 120_000 : 20_000)])
            const ticket = services.lifecycle.admit(owner, name, controller)
            let bundle: HeaderSecretBundle | null = null
            try {
                const initial = await current(signal)
                bundle = await readBundle()
                if (!bundle) throw new Error('Service account credentials unavailable')
                const guard = async () => {
                    signal.throwIfAborted(); ticket.assertCurrent()
                    const authority = await current(signal)
                    if (authority.runtime.launchNonce !== initial.runtime.launchNonce || authority.skillsRoot !== initial.skillsRoot) throw new Error('Service account authority changed')
                    const latest = await readBundle()
                    try { if (!latest || !bundle || !bundlesMatch(latest, bundle)) throw new Error('Service account credentials changed') }
                    finally { wipe(latest) }
                    signal.throwIfAborted(); ticket.assertCurrent()
                }
                await guard()
                const input = { url: plan.url, headers: bundle.headers, secretValues: Object.values(bundle.inputs), signal, guard }
                // A call always rediscovers membership under the same lease. A prior
                // catalog capability alone cannot authorize a newly changed endpoint.
                const discovered = await http.probe(input)
                await services.assertToolNames(owner, record.id, discovered.tools.map(tool => `${plan.serverName}_${tool.name}`), signal)
                await guard()
                if (!call) return discovered
                const fresh = await services.liveRecord(owner, record.key, revision, signal)
                if (!discovered.tools.some(tool => tool.name === call.name) || !fresh.toolNames.includes(`${plan.serverName}_${call.name}`)) throw new Error('Service tool is no longer available')
                const result = await http.call({ ...input, ...call })
                await guard()
                return result
            } finally {
                wipe(bundle); controller.abort(); ticket.release()
            }
        }
        return {
            probe: (owner, name, revision, signal) => services.trackTransport(owner, operate(owner, name, revision, undefined, signal)),
            call: (owner, name, revision, nameOfTool, args, signal) => services.trackTransport(owner, operate(owner, name, revision, { name: nameOfTool, arguments: args }, signal)),
            async validate(owner, name, revision, stop) {
                identity(owner, name, revision)
                const signal = AbortSignal.any([parent, stop, AbortSignal.timeout(20_000)])
                const check = services.lifecycle.watch(owner, name)
                check(); await current(signal)
                const bundle = await readBundle()
                try { if (!bundle) throw new Error('Service account credentials unavailable'); signal.throwIfAborted(); check() }
                finally { wipe(bundle) }
            },
        }
    }
}
