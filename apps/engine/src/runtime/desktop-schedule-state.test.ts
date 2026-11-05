import {createClient} from '@libsql/client'
import {afterEach,describe,expect,it,vi} from 'vitest'
const state=vi.hoisted(()=>({client:null as unknown}))
vi.mock('../db/systemDb.js',()=>({getSystemDb:async()=>({client:state.client})}))
import {desktopScheduleOccurrenceSchema,claimDesktopSchedule,finishDesktopSchedule,recoverDesktopScheduleClaims} from './desktop-schedule-state.js'
import type {Schedule} from '../schedules/loader.js'
const clients:ReturnType<typeof createClient>[]=[]
afterEach(()=>{for(const db of clients.splice(0))db.close()})
async function database(){const db=createClient({url:'file::memory:'});clients.push(db);state.client=db;await db.executeMultiple(desktopScheduleOccurrenceSchema);return db}
const schedule={slug:'daily',createdAt:'2026-01-01T00:00:00Z',lastRunAt:null} as Schedule
describe('desktop occurrence ownership',()=>{
    it('admits one racing due claim and does not replay it after recovery',async()=>{await database();const claims=await Promise.all([claimDesktopSchedule('a',schedule),claimDesktopSchedule('a',schedule)]);expect(claims.filter(Boolean)).toHaveLength(1);await recoverDesktopScheduleClaims('a');expect(await claimDesktopSchedule('a',schedule)).toBe(false);expect(await claimDesktopSchedule('a',{...schedule,lastRunAt:'2026-11-04T12:00:00Z'})).toBe(true)})
    it('deduplicates retries of manual identities and prevents overlap with a due occurrence',async()=>{await database();expect(await claimDesktopSchedule('a',schedule,'request-a')).toBe(true);expect(await claimDesktopSchedule('a',schedule,'request-b')).toBe(false);expect(await claimDesktopSchedule('a',schedule)).toBe(false);await finishDesktopSchedule('a',schedule,'request-a');expect(await claimDesktopSchedule('a',schedule,'request-a')).toBe(false);expect(await claimDesktopSchedule('a',schedule,'request-b')).toBe(true)})
})
