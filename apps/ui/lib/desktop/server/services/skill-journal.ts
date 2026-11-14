import 'server-only'
import type { Client, Row } from '@libsql/client'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { OwnedSkill, ServiceInstall, ServiceStore } from './store'
const resourceSchema = z.object({ slug: z.string().regex(/^svc-[a-f0-9]{16,24}-[0-9]+(?:-pending)?$/), directoryIdentity: z.string().regex(/^\d+:\d+$/), manifestVersion: z.string().regex(/^\d+:\d+:\d+:\d+:\d+$/), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const stateSchema = z.enum(['reserved', 'staged', 'published', 'acknowledged', 'removed'])
export type SkillReservation = { owner: string; engineId: string; installationId: string; index: number; slug: string; stageSlug: string; hash: string; state: z.infer<typeof stateSchema>; resource: OwnedSkill | null; publicationName: string | null }
export const serviceSkillMigrationSql = `CREATE TABLE desktop_service_skill_resources (
 owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
 engine_id TEXT NOT NULL, installation_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<8),
 slug TEXT NOT NULL, stage_slug TEXT NOT NULL, content_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('reserved','staged','published','acknowledged','removed')),
 resource TEXT, publication_name TEXT,
 PRIMARY KEY(owner,installation_id,ordinal), UNIQUE(owner,slug), UNIQUE(owner,stage_slug))`
function decode(row: Row): SkillReservation {
 const publicationName = row.publication_name == null ? null : String(row.publication_name)
 if (publicationName !== null && !/^\.rerun-skill-stage-[a-f0-9]{24}$/.test(publicationName)) throw new Error('Invalid skill publication identity')
 return { owner: String(row.owner), engineId: String(row.engine_id), installationId: String(row.installation_id), index: Number(row.ordinal), slug: String(row.slug), stageSlug: String(row.stage_slug), hash: String(row.content_hash), state: stateSchema.parse(row.state), resource: row.resource ? resourceSchema.parse(JSON.parse(String(row.resource))) : null, publicationName }
}
export function serviceSkillJournal(db: Client) {
 const read = async (owner: string, id: string, index: number) => {
  const row = (await db.execute({ sql: 'SELECT * FROM desktop_service_skill_resources WHERE owner=? AND installation_id=? AND ordinal=?', args: [owner, id, index] })).rows[0]
  return row ? decode(row) : null
 }
 return { read,
  async reserve(record: Pick<ServiceInstall, 'id' | 'owner' | 'engineId'>, index: number, hash: string) {
   if (!z.uuid().safeParse(record.id).success || !Number.isInteger(index) || index < 0 || index >= 8 || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid skill reservation')
   const prefix = createHash('sha256').update(record.id).digest('hex').slice(0, 24), slug = `svc-${prefix}-${index}`, stageSlug = `${slug}-pending`
   await db.execute({ sql: "INSERT INTO desktop_service_skill_resources(owner,engine_id,installation_id,ordinal,slug,stage_slug,content_hash,state) VALUES(?,?,?,?,?,?,?,'reserved') ON CONFLICT(owner,installation_id,ordinal) DO NOTHING", args: [record.owner, record.engineId, record.id, index, slug, stageSlug, hash] })
   const reservation = await read(record.owner, record.id, index)
   if (!reservation || reservation.hash !== hash || reservation.engineId !== record.engineId || reservation.slug !== slug || reservation.stageSlug !== stageSlug || reservation.state === 'removed') throw new Error('Skill reservation changed; preserved')
   return reservation
  },
  async update(reservation: SkillReservation, state: SkillReservation['state'], resource: OwnedSkill | null, publicationName = reservation.publicationName ?? null) {
   if (resource) resourceSchema.parse(resource)
   if (publicationName !== null && !/^\.rerun-skill-stage-[a-f0-9]{24}$/.test(publicationName)) throw new Error('Invalid skill publication identity')
   const result = await db.execute({ sql: 'UPDATE desktop_service_skill_resources SET state=?,resource=?,publication_name=? WHERE owner=? AND engine_id=? AND installation_id=? AND ordinal=? AND state=? AND content_hash=?', args: [state, resource ? JSON.stringify(resource) : null, publicationName, reservation.owner, reservation.engineId, reservation.installationId, reservation.index, reservation.state, reservation.hash] })
   if (result.rowsAffected !== 1) throw new Error('Skill reservation conflict')
   reservation.state = state; reservation.resource = resource; reservation.publicationName = publicationName
  },
  async list(owner: string) {
   const rows = (await db.execute({ sql: 'SELECT * FROM desktop_service_skill_resources WHERE owner=? ORDER BY installation_id,ordinal LIMIT 4097', args: [owner] })).rows
   if (rows.length > 4096) throw new Error('Skill reservation limit exceeded')
   return rows.map(decode)
  },
 }
}
export type ServiceSkillJournal = ReturnType<typeof serviceSkillJournal>
export async function currentSkillInstallation(store: ServiceStore, record: ServiceInstall) {
 const current = await store.read(record.owner, record.key)
 if (!current || current.id !== record.id || current.engineId !== record.engineId || current.revision !== record.revision) throw new Error('Skill installation changed')
 return current
}
