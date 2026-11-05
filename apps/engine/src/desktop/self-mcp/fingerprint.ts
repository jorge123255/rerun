import { createHash } from 'node:crypto'
import { selfMcpCanonicalInput, type SelfMcpServerInput } from '@rerun/contracts'

/**
 * sha256 hex of the canonical nonsecret input. The engine and the UI node
 * modules hash the exact same string (see `selfMcpCanonicalInput`), so the
 * fingerprint computed here always matches the one the UI recomputes at
 * proposal time; the UI refuses on mismatch.
 */
export function selfMcpFingerprint(input: SelfMcpServerInput): string {
    return createHash('sha256').update(selfMcpCanonicalInput(input)).digest('hex')
}
