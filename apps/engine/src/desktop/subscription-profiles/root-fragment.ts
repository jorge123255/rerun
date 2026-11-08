import { SUBSCRIPTION_PROFILE_DDL } from './store.js'

/** Root applies this inside the next desktop SQLite migration transaction. Do not assign a migration number here. */
export const subscriptionProfileMigrationFragment = {
    slot: 'NEXT_DESKTOP_SQLITE_MIGRATION',
    transaction: true,
    ddl: SUBSCRIPTION_PROFILE_DDL,
} as const

/**
 * Root wires this to the canonical connection custody. pendingRuns must be the real run list.
 * A missing stopAndDrain refuses removal. This module does not store or hash credentials.
 */
export const subscriptionProfileCustodyMount = {
    pendingRuns: 'SubscriptionProfileCustody.pendingRuns',
    stopAndDrain: 'SubscriptionProfileCustody.stopAndDrain',
    credentialGeneration: 'SubscriptionProfileCustody.credentialGeneration',
    reserved: ['apps/engine/src/desktop/codex-runtime.ts', 'apps/engine/src/desktop/claude-plan/runtime.ts', 'apps/engine/src/desktop/policy.ts', 'packages/contracts/src/index.ts'],
} as const
