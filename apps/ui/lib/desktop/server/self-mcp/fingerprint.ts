import 'server-only'
import { createHash } from 'node:crypto'
import { selfMcpCanonicalInput, type SelfMcpServerInput } from '@rerun/contracts'

/**
 * sha256 hex of the canonical nonsecret input. The engine and the UI node
 * modules hash the exact same string (see `selfMcpCanonicalInput`), so the
 * fingerprint recomputed here must equal the one the engine sent; the service
 * refuses the proposal on mismatch.
 */
export function selfMcpFingerprint(input: SelfMcpServerInput): string {
    return createHash('sha256').update(selfMcpCanonicalInput(input)).digest('hex')
}
