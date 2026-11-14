// Build-time release settings for macOS updates. A production release replaces
// PRODUCTION_FEED_URL, feedUrl, teamId, and bundleId together. Leave them empty here.
// Do not put a live feed host, token, or signing secret in this file.
export const PRODUCTION_FEED_URL = ''

export const BUILD_RELEASE = Object.freeze({
    channel: 'preview',
    feedUrl: '',
    devFeedUrl: '',
    teamId: '',
    bundleId: '',
})
