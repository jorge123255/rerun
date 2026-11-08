/** Original download cap. Card and preview caps are separate and do not admit these bytes. */
export const DOWNLOAD_LIMIT_BYTES = 50_000_000

/** Same deadline as desktop page reads. A timeout is a failure and is not retried. */
export const DOWNLOAD_DEADLINE_MS = 30_000

/** Mac page-read hop cap. The original download call asked fetchPublic for 10. */
export const DOWNLOAD_REDIRECT_LIMIT = 3

export const DOWNLOAD_LIMIT_TEXT = '50MB'
