import 'server-only'

// Read, offer and execution queries use this same Vault account scope for the Chief.
export const foremanSharedCatalogAccounts = "s.shared_with_all=1 AND s.catalog_slug IS NOT NULL AND s.transport='http'"
