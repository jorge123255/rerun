import { verifyMacUpdateSignature } from './mac-update-signature.mjs'
import { shellText } from './shell-language.mjs'
import { BUILD_RELEASE, PRODUCTION_FEED_URL } from './release-config.mjs'

export { BUILD_RELEASE, PRODUCTION_FEED_URL }

const TEAM_ID = /^[A-Z0-9]{10}$/
const DEV_CHANNELS = new Set(['dev', 'development', 'preview', 'internal'])
const PRODUCTION_CHANNELS = new Set(['stable', 'production'])
const FIRST_CHECK_DELAY_MS = 10_000
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

export function resolveMacUpdateFeed(release = {}, productionFeedUrl = PRODUCTION_FEED_URL) {
    const packaged = release.packaged === true
    const channel = typeof release.channel === 'string' ? release.channel : ''
    const teamId = typeof release.teamId === 'string' ? release.teamId : ''
    const hasTeamId = TEAM_ID.test(teamId)
    const feedUrl = cleanUrl(release.feedUrl)
    const devFeedUrl = cleanUrl(release.devFeedUrl)
    const productionUrl = cleanUrl(productionFeedUrl)
    const devLike = DEV_CHANNELS.has(channel)
    const productionChannel = PRODUCTION_CHANNELS.has(channel)

    if (!packaged) return disabled('unpackaged')
    if (!hasTeamId) return disabled('unsigned')
    if (devLike) {
        if (!devFeedUrl) return disabled('no-feed')
        if (!feedAllowed(devFeedUrl, true) || sameFeed(devFeedUrl, productionUrl) || sameOrigin(devFeedUrl, productionUrl)) return disabled('production-feed')
        return { enabled: true, feedUrl: devFeedUrl, production: false, reason: 'dev-feed' }
    }
    if (!productionChannel) return disabled('channel')
    if (!feedUrl) return disabled('no-feed')
    if (!feedAllowed(feedUrl, false) || !sameFeed(feedUrl, productionUrl)) return disabled('feed')
    return { enabled: true, feedUrl: productionUrl, production: true, reason: 'production' }
}

export function approvedQuitAction(updates, app) {
    try { if (updates?.commitInstall()) return true }
    catch { console.warn('Could not restart Rerun to install the update. Quitting normally.') }
    app.quit()
    return false
}

export function createMacUpdater({ autoUpdater, app, dialog, release, productionFeedUrl = PRODUCTION_FEED_URL, schedule = defaultSchedule, interval = defaultInterval, getWindow, onState,
    verifySignature = verifyMacUpdateSignature, text = () => shellText('en') } = {}) {
    let state = { status: 'idle' }
    let started = false
    let armed = false
    let installing = false
    let interactive = false
    let reported = false
    let prompting = false
    let decision = disabled('unstarted')

    const t = (key, values) => text()('updates.' + key, values)

    function publish(next) {
        state = copyState(next)
        try { onState?.(copyState(state)) } catch { /* A closed window cannot block the updater. */ }
    }

    function clip(error) {
        const raw = typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : ''
        let text = raw.replace(/[\r\n]+/g, ' ').trim()
        for (const secret of [productionFeedUrl, decision.feedUrl, release?.feedUrl, release?.devFeedUrl]) {
            if (typeof secret === 'string' && secret) text = text.split(secret).join('the update feed')
        }
        text = text.slice(0, 300).trim()
        return text || 'The update check failed.'
    }

    async function showDialog(options, parent = getWindow?.()) {
        if (typeof dialog?.showMessageBox !== 'function') return { response: options.cancelId ?? 0 }
        try {
            if (parent && parent.isDestroyed?.() !== true) return await dialog.showMessageBox(parent, options)
            return await dialog.showMessageBox(options)
        } catch {
            return { response: options.cancelId ?? 0 }
        }
    }

    async function unavailableDialog() {
        await showDialog({ type: 'info', message: t('disabled'), buttons: ['OK'], defaultId: 0, noLink: true })
    }

    async function upToDateDialog() {
        await showDialog({
            type: 'info', message: t('upToDate'),
            detail: t('upToDateDetail', { version: currentVersion(app) }),
            buttons: ['OK'], defaultId: 0, noLink: true,
        })
    }

    async function fail(error) {
        if (state.status === 'ready') {
            interactive = false
            return
        }
        if (reported) return
        reported = true
        const show = interactive
        interactive = false
        const message = clip(error)
        publish({ status: 'error', message })
        if (show) {
            await showDialog({ type: 'warning', message: t('failed'), detail: message, buttons: ['OK'], defaultId: 0, noLink: true })
        }
    }

    function onAvailable() {
        if (state.status !== 'ready') publish({ status: 'downloading' })
    }

    function onDownloaded(_event, _releaseNotes, releaseName) {
        interactive = false
        publish({ status: 'ready', version: versionOf(releaseName) })
    }

    function onMissing() {
        if (state.status === 'ready') {
            interactive = false
            return
        }
        const show = interactive
        interactive = false
        publish({ status: 'idle' })
        if (show) void upToDateDialog()
    }

    function bind() {
        if (typeof autoUpdater?.on !== 'function') return
        autoUpdater.on('error', error => { void fail(error) })
        autoUpdater.on('checking-for-update', () => { if (state.status !== 'ready') publish({ status: 'checking' }) })
        autoUpdater.on('update-available', onAvailable)
        autoUpdater.on('update-not-available', onMissing)
        autoUpdater.on('update-downloaded', onDownloaded)
    }

    function arm() {
        if (armed) return
        armed = true
        const first = schedule(() => { void api.checkForUpdates(false) }, FIRST_CHECK_DELAY_MS)
        const every = interval(() => { void api.checkForUpdates(false) }, CHECK_EVERY_MS)
        first?.unref?.()
        every?.unref?.()
    }

    function start(options = {}) {
        if (!started) {
            started = true
            const config = { ...BUILD_RELEASE, ...release, packaged: release?.packaged === true }
            decision = resolveMacUpdateFeed(config, productionFeedUrl)
            if (!decision.enabled) return decision
            if (!verifySignature(app, { teamId: config.teamId, bundleId: config.bundleId, production: decision.production })) {
                decision = disabled('signature')
                return decision
            }
            if (typeof autoUpdater?.setFeedURL !== 'function' || typeof autoUpdater.checkForUpdates !== 'function' || typeof autoUpdater.quitAndInstall !== 'function') {
                decision = disabled('updater')
                return decision
            }
            try { autoUpdater.setFeedURL({ url: decision.feedUrl, serverType: 'json' }) }
            catch {
                decision = disabled('feed')
                return decision
            }
            bind()
        }
        if (options.scheduleChecks === true && decision.enabled) arm()
        return decision
    }

    async function checkForUpdates(interactiveRequest) {
        if (!started) start()
        if (!decision.enabled) {
            if (interactiveRequest === true) await unavailableDialog()
            return copyState(state)
        }
        if (state.status === 'ready') {
            if (interactiveRequest === true) await offerInstall()
            return copyState(state)
        }
        if (state.status === 'checking' || state.status === 'downloading') return copyState(state)
        reported = false
        interactive = interactiveRequest === true
        publish({ status: 'checking' })
        try {
            const result = autoUpdater.checkForUpdates()
            if (result && typeof result.then === 'function') await result
        } catch (error) {
            await fail(error)
        }
        return copyState(state)
    }

    async function offerInstall({ parent, isCurrent = () => true } = {}) {
        if (!decision.enabled || state.status !== 'ready' || prompting || !isCurrent()) return false
        prompting = true
        try {
            const version = state.version
            const { response } = await showDialog({
                type: 'info',
                message: version ? t('readyToInstall', { version }) : t('ready'),
                detail: t('readyDetail'),
                buttons: [t('restartNow'), t('later')], defaultId: 0, cancelId: 1, noLink: true,
            }, parent)
            return response === 0 && isCurrent() && requestRestart()
        } finally { prompting = false }
    }

    function requestRestart() {
        if (state.status !== 'ready') return false
        let result
        try { result = app.quit() } catch { return false }
        if (result && typeof result.then === 'function') return result.then(() => true, () => true)
        return true
    }

    function commitInstall() {
        if (state.status !== 'ready' || installing) return false
        if (!decision.enabled || typeof autoUpdater?.quitAndInstall !== 'function') return false
        installing = true
        try { autoUpdater.quitAndInstall() }
        catch (error) {
            installing = false
            throw error
        }
        return true
    }

    function menuItem() {
        if (state.status === 'checking') return { label: t('checking'), enabled: false }
        if (state.status === 'downloading') return { label: t('downloading'), enabled: false }
        if (state.status === 'ready') return { label: t('restart'), enabled: true }
        return { label: t('check'), enabled: true }
    }

    const api = {
        start,
        enabled: () => decision.enabled,
        state: () => copyState(state),
        menuItem,
        checkForUpdates,
        checkFromMenu: () => state.status === 'ready' ? offerInstall() : checkForUpdates(true),
        offerInstall,
        requestRestart,
        commitInstall,
    }
    return api
}

function disabled(reason) {
    return { enabled: false, feedUrl: null, production: false, reason }
}

function cleanUrl(value) {
    return typeof value === 'string' ? value.trim() : ''
}

function canonical(url) {
    try {
        const parsed = new URL(url)
        if (parsed.username || parsed.password) return null
        const path = parsed.pathname.replace(/\/+$/, '') || '/'
        return `${parsed.protocol}//${parsed.host}${path}`
    } catch {
        return null
    }
}

function sameFeed(left, right) {
    const a = canonical(left)
    const b = canonical(right)
    return Boolean(a && b && a === b)
}

function sameOrigin(left, right) {
    try { return new URL(left).origin === new URL(right).origin } catch { return false }
}

function feedAllowed(url, allowLoopback) {
    let parsed
    try { parsed = new URL(url) } catch { return false }
    if (parsed.username || parsed.password) return false
    if (parsed.protocol === 'https:') return true
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
    return allowLoopback && parsed.protocol === 'http:' && loopback
}

function versionOf(releaseName) {
    if (typeof releaseName !== 'string' || releaseName.length > 64) return ''
    return /^v?\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i.test(releaseName) ? releaseName : ''
}

function copyState(next) {
    if (next.status === 'downloading') return { status: 'downloading' }
    if (next.status === 'ready') return { status: 'ready', version: next.version || '' }
    if (next.status === 'error') return { status: 'error', message: next.message || 'The update check failed.' }
    if (next.status === 'checking') return { status: 'checking' }
    return { status: 'idle' }
}

function currentVersion(app) {
    try {
        const version = app?.getVersion?.()
        return typeof version === 'string' && version.trim() ? version.trim() : '0.0.0'
    } catch {
        return '0.0.0'
    }
}

function defaultSchedule(callback, delay) {
    const timer = setTimeout(callback, delay)
    timer.unref?.()
    return timer
}

function defaultInterval(callback, delay) {
    const timer = setInterval(callback, delay)
    timer.unref?.()
    return timer
}
