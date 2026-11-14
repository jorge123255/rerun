import 'server-only'
import { desktopWorkspaceRoutineMutationSchema, desktopWorkspaceRoutinesViewSchema } from '@rerun/contracts'
import { boundedText } from '../mcp/remote'
import { DesktopHttpError } from '../auth'
import type { DesktopWorkspaceRoutinesAuthority } from './reader'
import { createDesktopWorkspaceRoutinesReader } from './reader'
import { createDesktopWorkspaceRoutinesMutator, type DesktopWorkspaceRoutinesMutationAuthority } from './mutations'

export function createDesktopWorkspaceRoutinesApi(authority: DesktopWorkspaceRoutinesAuthority & DesktopWorkspaceRoutinesMutationAuthority) {
    const reader = createDesktopWorkspaceRoutinesReader(authority)
    const mutator = createDesktopWorkspaceRoutinesMutator(authority)
    return {
        async GET(request: Request): Promise<Response> {
            const view = await reader.list(request.signal)
            return Response.json(desktopWorkspaceRoutinesViewSchema.parse(view), { headers: { 'Cache-Control': 'no-store' } })
        },
        async POST(request: Request): Promise<Response> {
            const text = await boundedText(new Response(request.body), AbortSignal.any([request.signal, AbortSignal.timeout(10000)]), 80_000)
            if (Buffer.byteLength(text, 'utf8') > 80_000) throw new DesktopHttpError(413, 'Routine decision is too large.')
            const input = desktopWorkspaceRoutineMutationSchema.parse(JSON.parse(text))
            const result = input.action === 'rename' ? await mutator.rename(input, request.signal)
                : input.action === 'toggle' ? await mutator.toggle(input, request.signal)
                    : input.action === 'run' ? await mutator.run(input, request.signal)
                        : await mutator.edit(input, request.signal)
            return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
        },
    }
}
