import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { dataDir } from '../../config/paths.js'
import { HttpError } from '../../lib/errors.js'
import { prepareDesktopDataFile, verifyDesktopDataFile } from '../data-executor.js'
import { getDesktopBrainStore } from '../brain-pages-router.js'
import { desktopApp } from '../policy.js'
import { bindDesktopCompanyBriefBrain, type CompanyBriefBrain } from './brain.js'
import { openDesktopCompanyBriefModel } from './model.js'
import { createCompanyBriefService, type CompanyBriefService } from './service.js'

// Sibling of brain-db. Not inside shared/, so a coworker file tool cannot rewrite the brief.
export function companyBriefDbFile(): string {
    return resolve(dataDir(), 'company-brief-db', 'company-brief.db')
}

let singleton: CompanyBriefService | null = null
let client: Client | null = null
let brain: CompanyBriefBrain | null = null

function brainPort(): CompanyBriefBrain {
    return {
        readPage: async slug => (await boundBrain()).readPage(slug),
        openProposal: async slug => (await boundBrain()).openProposal(slug),
        propose: async draft => (await boundBrain()).propose(draft),
    }
}

async function boundBrain(): Promise<CompanyBriefBrain> {
    brain ??= bindDesktopCompanyBriefBrain(await getDesktopBrainStore())
    return brain
}

// Schema and restart reconcile only. Does not read a model, propose a page, or synthesize.
export async function initializeDesktopCompanyBriefStore(): Promise<void> {
    if (!desktopApp()) return
    const file = companyBriefDbFile()
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const pin = await prepareDesktopDataFile(dataDir(), file)
    client ??= createClient({ url: `file:${file}` })
    await verifyDesktopDataFile(pin)
    const service = createCompanyBriefService(async () => {
        if (!client) throw new HttpError(503, 'Company brief storage is not initialized.')
        await verifyDesktopDataFile(pin)
        return client
    }, { model: openDesktopCompanyBriefModel(), brain: brainPort() })
    await service.initialize()
    singleton = service
}

export function getCompanyBriefService(): CompanyBriefService {
    if (!singleton) throw new HttpError(503, 'Company brief storage is not initialized.')
    return singleton
}
