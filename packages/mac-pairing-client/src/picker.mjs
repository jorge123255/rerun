import { START_ENTRIES } from './protocol.mjs'

// Mirrors upstream StartStep (apps/mobile/src/components/auth/steps/StartStep.tsx
// at 5222e848 lines 124-143): the cloud/self-hosted buttons stay as they are,
// "Use your own server" remains the entry into the existing ServerStep, and
// "Connect to This Mac" is a sibling entry that must not call switchServer().
export function startSignInEntries() {
    return START_ENTRIES.map(entry => ({ ...entry }))
}
