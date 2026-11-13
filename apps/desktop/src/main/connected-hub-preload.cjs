const { contextBridge, ipcRenderer } = require('electron')

const bootstrap = ipcRenderer.sendSync('hub:bootstrap')
function subscribe(channel, callback) {
    if (typeof callback !== 'function') throw new TypeError('Expected a listener')
    const listener = (_event, value) => callback(value)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
}

if (bootstrap?.audience === 'picker') {
    contextBridge.exposeInMainWorld('rerunHubPicker', {
        copy: bootstrap.copy,
        savedOrigin: () => ipcRenderer.invoke('hub:saved-origin'),
        connect: address => ipcRenderer.invoke('hub:connect', address),
        connectCloud: () => ipcRenderer.invoke('hub:connect-cloud'),
    })
} else if (bootstrap?.audience === 'hub-offline') {
    contextBridge.exposeInMainWorld('rerunHubOffline', {
        copy: bootstrap.copy,
        appearance: bootstrap.appearance === 'light' ? 'light' : 'dark',
        state: () => ipcRenderer.invoke('hub:offline-state'),
        retry: () => ipcRenderer.invoke('hub:offline-retry'),
        ...(bootstrap.appStore ? { appStore: true } : { download: () => ipcRenderer.invoke('hub:offline-download') }),
        onState: callback => subscribe('hub:offline-state-changed', callback),
        ...(bootstrap.updatesAvailable ? { update: {
            getState: () => ipcRenderer.invoke('hub:offline-update-state'),
            check: () => ipcRenderer.invoke('hub:offline-update-check'),
            install: () => ipcRenderer.invoke('hub:offline-update-install'),
            onState: callback => subscribe('hub:offline-update-changed', callback),
        } } : {}),
    })
} else if (bootstrap?.audience === 'hub-quick-ask') {
    contextBridge.exposeInMainWorld('rerunShell', {
        apiVersion: bootstrap.apiVersion,
        version: bootstrap.version,
        platform: bootstrap.platform,
        channel: bootstrap.channel,
        capabilities: ['quickAsk'],
        quickAsk: {
            shortcut: bootstrap.shortcut,
            close: () => { void ipcRenderer.invoke('hub:quick-ask-close').catch(() => {}) },
            sent: path => { void ipcRenderer.invoke('hub:quick-ask-sent', path).catch(() => {}) },
        },
    })
} else if (bootstrap?.audience === 'hub') {
    let oauthRegistration = null
    let oauthSequence = 0
    function clearOAuth(registration) {
        if (oauthRegistration !== registration) return
        oauthRegistration = null
        ipcRenderer.removeListener('hub:oauth-return', registration.listener)
        void ipcRenderer.invoke('hub:oauth-cancel', registration.id).catch(() => {})
    }
    function onOAuthReturn(callback) {
        if (typeof callback !== 'function') throw new TypeError('Expected a listener')
        if (oauthRegistration) {
            const previous = oauthRegistration
            clearOAuth(previous)
            try { previous.callback({ status: 'error', message: 'Another service sign-in started' }) } catch {}
        }
        const registration = { id: String(++oauthSequence), callback, listener: (_event, value) => {
            if (oauthRegistration !== registration || value?.registrationId !== registration.id) return
            clearOAuth(registration)
            callback(value.result)
        } }
        oauthRegistration = registration
        ipcRenderer.on('hub:oauth-return', registration.listener)
        return () => clearOAuth(registration)
    }
    contextBridge.exposeInMainWorld('rerunShell', {
        apiVersion: bootstrap.apiVersion,
        version: bootstrap.version,
        platform: bootstrap.platform,
        channel: bootstrap.channel,
        capabilities: bootstrap.capabilities,
        ...(bootstrap.capabilities.includes('update') ? { update: {
            getState: () => ipcRenderer.invoke('hub:update-state').then(state => state ?? { status: 'idle' }),
            onState: callback => subscribe('hub:update-state', callback),
            check: () => { void ipcRenderer.invoke('hub:update-check').catch(() => {}) },
            install: () => { void ipcRenderer.invoke('hub:update-install').catch(() => {}) },
        } } : {}),
        auth: {
            startBrowserSignIn: options => ipcRenderer.invoke('hub:auth-start', { provider: options?.provider }),
            submitCode: code => ipcRenderer.invoke('hub:auth-code', code),
            onResult: callback => subscribe('hub:auth-result', callback),
        },
        window: {
            getState: () => ipcRenderer.invoke('hub:window-state'),
            onState: callback => subscribe('hub:window-state', callback),
            setChrome: colors => { void ipcRenderer.invoke('hub:window-chrome', { frameColor: colors?.frameColor, symbolColor: colors?.symbolColor }).catch(() => {}) },
        },
        find: { open: () => { void ipcRenderer.invoke('hub:find').catch(() => {}) } },
        links: { openExternal: url => ipcRenderer.invoke('hub:open-link', url, oauthRegistration?.id) },
        downloads: {
            onEvent: callback => subscribe('hub:download', callback),
            show: id => { void ipcRenderer.invoke('hub:show-download', id).catch(() => {}) },
        },
        notifications: {
            show: notice => ipcRenderer.invoke('hub:notify', notice).catch(() => false),
            onClick: callback => subscribe('hub:notification-click', callback),
        },
        badge: { set: count => {
            let workspace = null
            try { workspace = sessionStorage.getItem('rerun:tab-workspace') } catch {}
            void ipcRenderer.invoke('hub:badge', count, workspace).catch(() => {})
        } },
        locale: {
            set: locale => {
                if (typeof locale === 'string' && locale.length <= 5) void ipcRenderer.invoke('hub:locale', locale).catch(() => {})
            },
        },
        settings: {
            get: () => ipcRenderer.invoke('hub:settings'),
            set: patch => ipcRenderer.invoke('hub:set-settings', { quickAsk: patch?.quickAsk, openAtLogin: patch?.openAtLogin }),
        },
        oauth: { onReturn: onOAuthReturn },
        server: { openPicker: () => { void ipcRenderer.invoke('hub:open-picker').catch(() => {}) } },
    })
}
