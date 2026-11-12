import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pathExists } from './workspaces/paths.mjs'

function contains(root, candidate) {
    const path = relative(root, candidate)
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export function configureStartupProfile(app, override = process.env.RERUN_DESKTOP_USER_DATA) {
    const appData = app.getPath('appData')
    const previewName = 'Rerun Desktop Preview'
    const defaultRoot = join(appData, previewName)
    let dataRoot = defaultRoot
    if (!app.isPackaged && override !== undefined) {
        if (!isAbsolute(override) || !statSync(override, { throwIfNoEntry: false })?.isDirectory()) {
            throw new Error('RERUN_DESKTOP_USER_DATA must be an existing absolute directory.')
        }
        dataRoot = realpathSync(override)
        let installedRoot
        try { installedRoot = realpathSync(defaultRoot) }
        catch (error) {
            if (error.code !== 'ENOENT') throw error
            installedRoot = join(realpathSync(appData), previewName)
        }
        if (contains(installedRoot, dataRoot) || contains(dataRoot, installedRoot)) {
            throw new Error('RERUN_DESKTOP_USER_DATA must be separate from the installed preview profile.')
        }
        app.setName('Rerun Desktop Development')
    } else {
        mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
    }
    // Select both paths before Electron chooses its singleton and Chromium session storage.
    app.setPath('userData', dataRoot)
    app.setPath('sessionData', dataRoot)
    return dataRoot
}

export async function hasLocalWorkspace(dataRoot) {
    // An older workspace can still have data even if its identity is missing.
    // Give it the normal local startup and recovery path in that case.
    for (const entry of ['identity.encrypted', 'app.db', 'workspaces']) {
        if (await pathExists(join(dataRoot, entry))) return true
    }
    return false
}
