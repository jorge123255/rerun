import 'server-only'

import bundledCatalog from './bundled-services.json'
import { createDesktopServiceCatalog, type DesktopServiceCatalogFile } from './catalog'

const catalog = createDesktopServiceCatalog(bundledCatalog as DesktopServiceCatalogFile)

export const desktopServiceCatalogProvenance = catalog.provenance
export const listDesktopServiceCatalog = catalog.listDesktopServiceCatalog
export const getDesktopServiceManifest = catalog.getDesktopServiceManifest
export const getDesktopServiceMethodAvailability = catalog.getDesktopServiceMethodAvailability
