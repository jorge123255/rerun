import 'server-only'
import { createHash } from 'node:crypto'
import type { DesktopForemanDocsCorpus, DesktopForemanDocsRequest } from '@rerun/contracts'

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const desktopForemanDocsCorpusFingerprint = (corpus: DesktopForemanDocsCorpus) => fingerprint(corpus)
export const desktopForemanDocsRequestFingerprint = (request: DesktopForemanDocsRequest) => fingerprint(request)
export const desktopForemanDocsBodyFingerprint = (body: string) => createHash('sha256').update(body).digest('hex')
