import 'server-only'

export { ensureDesktopMcpSecretReferenceSchema, desktopMcpSecretReferenceSchema } from './schema'
export { createDesktopMcpSecretLookup, type DesktopMcpSecretLookup, type DesktopMcpSecretOpener, type DesktopMcpSecretGate } from './lookup'
export { withDesktopMcpSecrets, DesktopMcpSecretReferenceFailure, type DesktopMcpResolvedMaterial, type DesktopMcpSecretAdmission } from './resolve'
export { createDesktopMcpSecretReferenceStore, DesktopMcpSecretReferenceConflict, type DesktopMcpSecretReferenceStore, type DesktopMcpPublicConfigPort, type DesktopMcpSecretReferenceExecutor } from './store'
export { bindDesktopMcpSecretReferences, type DesktopMcpSecretLifecycle, type DesktopMcpSecretReferenceHooks } from './hooks'
export { linkDesktopMcpProposalCredentials, type DesktopMcpProposalLink } from './proposals'
export { createDesktopMcpSecretReferenceHandlers, type DesktopMcpSecretReferenceActor } from './handler'
