const { contextBridge, ipcRenderer } = require('electron')
let beforeQuit
let notificationClicks = null
let registrationSequence = 0

ipcRenderer.on('desktop:before-quit', (_event, value) => {
    const current = beforeQuit
    if (!current || value?.registrationId !== current.registrationId || typeof value.requestId !== 'string'
        || !value.requestId || value.requestId.length > 128) return
    if (current.requestId === value.requestId) return
    current.requestId = value.requestId
    const saveDraft = (agentId, body) => ipcRenderer.invoke('desktop:save-draining-draft', {
        requestId: value.requestId, registrationId: current.registrationId, agentId, body,
    })
    Promise.resolve().then(() => current.listener(saveDraft)).then(saved => reply(saved === true), () => reply(false))
    function reply(saved) {
        if (beforeQuit === current && current.requestId === value.requestId) {
            ipcRenderer.send('desktop:drafts-flushed', { requestId: value.requestId, registrationId: current.registrationId, saved })
        }
    }
})

contextBridge.exposeInMainWorld('desktopApp', {
    ...(process.platform === 'darwin' ? {
        openFind: () => ipcRenderer.send('desktop:find-open'),
        setLanguage: locale => {
            if (typeof locale === 'string' && locale.length <= 5) ipcRenderer.send('desktop:language', locale)
        },
        quickAskSettings: {
            read: () => ipcRenderer.invoke('desktop:quick-ask-settings'),
            set: enabled => ipcRenderer.invoke('desktop:quick-ask-set-shortcut', enabled),
        },
        onQuickAsk: listener => {
            if (typeof listener !== 'function') throw new TypeError('Expected a Quick Ask listener')
            const registrationId = String(++registrationSequence)
            let active = true
            const handler = (_event, value) => {
                if (!active || value?.registrationId !== registrationId) return
                const acknowledge = accepted => {
                    if (active) ipcRenderer.send('desktop:quick-ask-ack', { registrationId, requestId: value.requestId, accepted: accepted === true })
                }
                void Promise.resolve().then(() => listener({ prompt: value.prompt, requestId: value.requestId }))
                    .then(acknowledge, () => acknowledge(false))
            }
            ipcRenderer.on('desktop:quick-ask-deliver', handler)
            ipcRenderer.send('desktop:quick-ask-ready', { registrationId })
            return () => {
                active = false
                ipcRenderer.removeListener('desktop:quick-ask-deliver', handler)
                ipcRenderer.send('desktop:quick-ask-unready', { registrationId })
            }
        },
        updates: {
            getState: () => ipcRenderer.invoke('desktop:update-state'),
            check: () => ipcRenderer.invoke('desktop:update-check'),
            install: () => ipcRenderer.invoke('desktop:update-install'),
            onState: listener => {
                if (typeof listener !== 'function') throw new TypeError('Expected an update listener')
                const handler = (_event, value) => listener(value)
                ipcRenderer.on('desktop:update-state', handler)
                return () => ipcRenderer.removeListener('desktop:update-state', handler)
            },
        },
        onMacFullscreen: listener => {
            if (typeof listener !== 'function') throw new TypeError('Expected a full-screen listener')
            let current = true, received = false
            const channel = 'desktop:mac-fullscreen-changed'
            const update = (_event, fullscreen) => {
                if (!current || typeof fullscreen !== 'boolean') return
                received = true
                listener(fullscreen)
            }
            ipcRenderer.on(channel, update)
            void ipcRenderer.invoke('desktop:mac-fullscreen').then(fullscreen => {
                if (!received) update(null, fullscreen)
            }, () => {})
            return () => {
                current = false
                ipcRenderer.removeListener(channel, update)
            }
        },
    } : {}),
    workspaces: {
        list: () => ipcRenderer.invoke('desktop:workspaces-list'),
        create: input => ipcRenderer.invoke('desktop:workspaces-create', input),
        rename: input => ipcRenderer.invoke('desktop:workspaces-rename', input),
        switchTo: input => ipcRenderer.invoke('desktop:workspaces-switch', input),
        recoverSwitch: input => ipcRenderer.invoke('desktop:workspaces-recover', input),
        reconcile: () => ipcRenderer.invoke('desktop:workspaces-reconcile'),
    },
    remoteMachines: {
        actor: () => ipcRenderer.invoke('desktop:remote-machines-actor'),
        execute: command => ipcRenderer.invoke('desktop:remote-machines-execute', command),
    },
    coworkerShare: {
        pickImport: () => ipcRenderer.invoke('desktop:coworker-share-pick'),
    },
    saveResultFile: (name, bytes) => ipcRenderer.invoke('desktop:result-save', { name, bytes }),
    saveCoworkerFile: value => ipcRenderer.invoke('desktop:coworker-file-save', { agentId: value?.agentId, path: value?.path, version: value?.version }),
    saveSharedFile: value => ipcRenderer.invoke('desktop:shared-file-save', { workspaceId: value?.workspaceId, path: value?.path, version: value?.version, identity: value?.identity }),
    templates: {
        pickImport: () => ipcRenderer.invoke('desktop:template-pick'),
        saveArtifact: value => ipcRenderer.invoke('desktop:template-save', { artifactId: value?.artifactId }),
    },
    notifications: {
        notify: value => ipcRenderer.invoke('desktop:notify', value),
        setInboxBadge: value => ipcRenderer.send('desktop:inbox-badge', {
            workspaceId: value?.workspaceId, launchNonce: value?.launchNonce, count: value?.count,
        }),
        onNotificationClick: listener => {
            if (typeof listener !== 'function') throw new TypeError('Expected a notification-click listener')
            const current = { registrationId: String(++registrationSequence) }
            notificationClicks = current
            const handler = (_event, value) => { if (notificationClicks === current) listener(value) }
            ipcRenderer.on('desktop:notification-click', handler)
            ipcRenderer.send('desktop:notification-clicks-ready', { registrationId: current.registrationId })
            return () => {
                ipcRenderer.removeListener('desktop:notification-click', handler)
                if (notificationClicks !== current) return
                notificationClicks = null
                ipcRenderer.send('desktop:notification-clicks-unready', { registrationId: current.registrationId })
            }
        },
    },
    getStatus: () => ipcRenderer.invoke('desktop:status'),
    openLocalWorkspace: () => ipcRenderer.invoke('desktop:startup-local'),
    signInToCloud: () => ipcRenderer.invoke('desktop:startup-cloud'),
    connectToServer: () => ipcRenderer.invoke('desktop:startup-connect'),
    retry: () => ipcRenderer.invoke('desktop:retry'),
    quit: () => ipcRenderer.invoke('desktop:quit'),
    onBeforeQuit: listener => {
        if (typeof listener !== 'function') throw new TypeError('Expected a draft-save listener')
        const current = { listener, registrationId: String(++registrationSequence) }
        beforeQuit = current
        ipcRenderer.send('desktop:drafts-ready', { registrationId: current.registrationId })
        return () => {
            if (beforeQuit !== current) return
            beforeQuit = null
            ipcRenderer.send('desktop:drafts-unready', { registrationId: current.registrationId })
        }
    },
    onOpenSettings: listener => {
        if (typeof listener !== 'function') throw new TypeError('Expected a Settings listener')
        const handler = () => listener()
        ipcRenderer.on('desktop:open-settings', handler)
        return () => ipcRenderer.removeListener('desktop:open-settings', handler)
    },
    onQuitCancelled: listener => {
        if (typeof listener !== 'function') throw new TypeError('Expected a quit-cancelled listener')
        const handler = () => listener()
        ipcRenderer.on('desktop:quit-cancelled', handler)
        return () => ipcRenderer.removeListener('desktop:quit-cancelled', handler)
    },
    onStatus: listener => {
        if (typeof listener !== 'function') throw new TypeError('Expected a status listener')
        const handler = (_event, value) => listener({
            state: value.state, message: value.message,
            ...(value.choices && { choices: {
                local: value.choices.local, cloud: value.choices.cloud, connect: value.choices.connect,
                connecting: value.choices.connecting, unreachable: value.choices.unreachable,
            } }),
        })
        ipcRenderer.on('desktop:status', handler)
        return () => ipcRenderer.removeListener('desktop:status', handler)
    },
})
