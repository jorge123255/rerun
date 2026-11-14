import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import { withRosterWrite } from '../roster-writes'
import { serviceSkillJournal } from '../services/skill-journal'
import { acknowledgeServiceSkill, createServiceSkill, removeServiceSkill, resolveServiceSkillRemoval } from '../services/skill-resources'
import { serviceStore } from '../services/store'
import { vaultCatalogSkills } from './catalog'

function assignedApps(db: Client, owner: string, engineId: string) {
    return db.execute({ sql: `SELECT s.id,s.catalog_slug,s.catalog_method,s.revision,x.installation_id AS legacy_id
        FROM desktop_vault_mcp_servers s
        JOIN desktop_agents a ON a.id=? AND a.engine_agent_id=? AND a.workspace_id=1
        LEFT JOIN desktop_vault_catalog_adoptions x ON x.item_id=s.id AND x.owner=a.id AND x.engine_id=a.engine_agent_id
        WHERE s.catalog_slug IS NOT NULL
        AND (s.shared_with_all=1 OR EXISTS (SELECT 1 FROM desktop_vault_mcp_attachments t WHERE t.item_id=s.id AND t.agent_id=a.id))
        AND NOT EXISTS (SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id OR d.engine_agent_id=a.engine_agent_id)
        AND NOT EXISTS (SELECT 1 FROM desktop_remote_mcp p WHERE p.agent_id=a.id AND p.name=s.name)
        AND NOT EXISTS (SELECT 1 FROM desktop_mcp_stdio p WHERE p.owner=a.id AND p.name=s.name)
        AND NOT EXISTS (SELECT 1 FROM desktop_service_installs p WHERE p.owner=a.id AND json_extract(p.plan,'$.serverName')=s.name
            AND NOT EXISTS (SELECT 1 FROM desktop_vault_catalog_adoptions x WHERE x.installation_id=p.id))`,
        args: [owner, engineId] })
}

/** Reconcile a coworker's journal with its current Vault assignments before exposing Skills. */
export function reconcileVaultCatalogSkills(db: Client, scope: { owner: string; engineId: string; skillsRoot: string }, checkScope: () => Promise<void>) {
    return withRosterWrite(async () => {
        await checkScope()
        const { owner, engineId, skillsRoot } = scope
        const journal = serviceSkillJournal(db)
        const assignments = (await assignedApps(db, owner, engineId)).rows
        const sets = (await db.execute({ sql: 'SELECT item_id,installation_id,engine_id FROM desktop_vault_catalog_skill_sets WHERE owner=?', args: [owner] })).rows
        const reservations = await journal.list(owner)
        const hidden = new Set<string>()
        for (const set of sets) {
            const app = assignments.find(item => item.id === set.item_id)
            if (app && !app.legacy_id && set.engine_id === engineId) continue
            const guard = async () => {
                await checkScope()
                const current = (await assignedApps(db, owner, engineId)).rows.some(item => item.id === set.item_id && !item.legacy_id)
                if (current || set.engine_id !== engineId) throw new Error('Vault app skill ownership changed')
            }
            for (const reservation of reservations.filter(row => row.installationId === set.installation_id)) {
                hidden.add(reservation.slug)
                hidden.add(reservation.stageSlug)
                try {
                    await guard()
                    if (reservation.resource && reservation.state !== 'removed') {
                        const resource = await resolveServiceSkillRemoval(skillsRoot, reservation, guard)
                        await removeServiceSkill(skillsRoot, resource, guard)
                    }
                    await db.execute({ sql: 'DELETE FROM desktop_service_skill_resources WHERE owner=? AND installation_id=? AND ordinal=?',
                        args: [owner, String(set.installation_id), reservation.index] })
                } catch { await checkScope() } // A changed file is preserved and stays hidden and reserved.
            }
            await db.execute({ sql: `DELETE FROM desktop_vault_catalog_skill_sets WHERE owner=? AND item_id=? AND installation_id=?
                AND NOT EXISTS(SELECT 1 FROM desktop_service_skill_resources WHERE owner=? AND installation_id=?)`,
                args: [owner, String(set.item_id), String(set.installation_id), owner, String(set.installation_id)] })
        }
        // Older builds still need the original installation. Hide its skills in this build once
        // the originating coworker no longer holds the adopted Vault entry.
        const legacy = (await db.execute({ sql: 'SELECT installation_id,item_id FROM desktop_vault_catalog_adoptions WHERE owner=? AND engine_id=?',
            args: [owner, engineId] })).rows
        const detached = new Set(legacy.filter(source => !assignments.some(item => item.id === source.item_id)).map(source => source.installation_id))
        if (detached.size) {
            for (const reservation of reservations) {
                if (!detached.has(reservation.installationId)) continue
                hidden.add(reservation.slug)
                hidden.add(reservation.stageSlug)
            }
            const store = serviceStore(db, () => { throw new Error('Skill ownership does not read credentials') })
            for (const record of await store.forSkillOwnership(owner)) {
                if (detached.has(record.id)) for (const skill of record.skills) hidden.add(skill.slug)
            }
        }
        for (const app of assignments) {
            if (app.legacy_id) continue
            const skills = vaultCatalogSkills(String(app.catalog_slug), String(app.catalog_method))
            const set = sets.find(row => row.item_id === app.id)
            if (!skills.length && !set) continue
            if (set && set.engine_id !== engineId) continue
            const id = set ? String(set.installation_id) : randomUUID()
            const guard = async () => {
                await checkScope()
                if (!(await assignedApps(db, owner, engineId)).rows.some(row => row.id === app.id && row.revision === app.revision && !row.legacy_id)) {
                    throw new Error('Vault app assignment changed')
                }
            }
            await guard()
            if (!set) await db.execute({ sql: 'INSERT INTO desktop_vault_catalog_skill_sets(owner,item_id,installation_id,engine_id) VALUES(?,?,?,?)',
                args: [owner, String(app.id), id, engineId] })
            for (const [index, skill] of skills.entries()) {
                try {
                    await createServiceSkill(skillsRoot, { id, owner, engineId }, index, skill, guard, journal)
                    const reservation = await journal.read(owner, id, index)
                    if (!reservation) throw new Error('Vault app skill reservation disappeared')
                    await acknowledgeServiceSkill(journal, reservation)
                    hidden.add(reservation.stageSlug)
                } catch {
                    await guard()
                    const reservation = await journal.read(owner, id, index)
                    if (!reservation) throw new Error('Could not prepare the app skill')
                    hidden.add(reservation.slug)
                    hidden.add(reservation.stageSlug)
                }
            }
            for (const reservation of reservations.filter(row => row.installationId === id && row.index >= skills.length)) {
                hidden.add(reservation.slug)
                hidden.add(reservation.stageSlug)
            }
        }
        await checkScope()
        return hidden
    })
}

export async function vaultCatalogSkillOwners(db: Client, owner: string) {
    const { rows } = await db.execute({ sql: `SELECT j.slug,s.catalog_name
        FROM desktop_vault_catalog_skill_sets v
        JOIN desktop_service_skill_resources j ON j.owner=v.owner AND j.installation_id=v.installation_id
        JOIN desktop_vault_mcp_servers s ON s.id=v.item_id
        WHERE v.owner=? AND j.state='acknowledged'`, args: [owner] })
    return rows.map(row => [String(row.slug), String(row.catalog_name)] as const)
}
