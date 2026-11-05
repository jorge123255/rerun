import {describe,it,expect,vi} from 'vitest'
const state=vi.hoisted(()=>({row:null as any,run:null as any,session:null as any,sql:''}))
vi.mock('../db/systemDb.js',()=>({getSystemDb:async()=>({client:{execute:async(input:any)=>{state.sql=input.sql;return {rows:state.row?[state.row]:[],rowsAffected:1}}}})}))
vi.mock('../db/repos/runs.js',()=>({getRun:async()=>state.run}))
vi.mock('../db/repos/sessions.js',()=>({getSession:async()=>state.session}))
import {claimDesktopSchedule,replayDesktopSchedule} from './desktop-schedule-state.js'
import type {Schedule} from '../schedules/loader.js'
describe('durable schedule receipt',()=>{
 it('preserves SQL claimed/started state predicates',async()=>{
  await claimDesktopSchedule('a',{slug:'s',createdAt:'now'} as Schedule,'uuid')
  expect(state.sql).toContain("state IN ('claimed','started')")
 })
 it('replays a recorded receipt after restart without claiming another occurrence',async()=>{
  state.row={session_id:'session',run_id:'run',state:'settled'}
  state.run={id:'run',agentId:'a',sessionId:'session',triggerSource:'schedule',triggerSlug:'s'}
  state.session={id:'session',agentId:'a',source:'schedule'}
  expect(await replayDesktopSchedule('a','s','uuid')).toEqual({sessionId:'session',runId:'run'})
  state.run.agentId='other'
  await expect(replayDesktopSchedule('a','s','uuid')).rejects.toThrow('ownership')
 })
 it('reports incomplete receipts without relaunching',async()=>{
  state.row={session_id:null,run_id:null,state:'interrupted'}
  await expect(replayDesktopSchedule('a','s','uuid')).rejects.toThrow('reconciliation')
 })
})
