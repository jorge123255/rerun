import { createClient } from '@libsql/client'
import { expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { foremanVoiceStore, FOREMAN_VOICE_SCHEMA_SQL, voiceScope } from './store'
import { canonicalForemanVoiceSend } from './runtime'
import type { desktopForeman } from '../foreman/binding'
const target={chat:{workspaceId:'1',chatId:'fmc_00000000-0000-4000-8000-000000000001'},model:{connectionId:'c',model:'m'}}
test('durable Foreman audio refuses target substitution and cancelled epochs without coworker rows',async()=>{
 const db=createClient({url:':memory:'});try{
  await db.executeMultiple("CREATE TABLE desktop_foreman_chats(chat_id TEXT PRIMARY KEY);INSERT INTO desktop_foreman_chats VALUES('fmc_00000000-0000-4000-8000-000000000001');CREATE TABLE desktop_voice_blobs(byte_length INTEGER);"+FOREMAN_VOICE_SCHEMA_SQL)
  const storage=foremanVoiceStore(db,target,0),id='00000000-0000-4000-8000-000000000002',bytes=new Uint8Array([1,2,3])
  const record={fingerprint:'immutable',draft:{attemptId:id,scope:voiceScope(target),phase:'uploading' as const,revision:'00000000-0000-4000-8000-000000000003',recording:{attemptId:id,sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:3,mimeType:'audio/webm',extension:'webm' as const,transcriptionFormat:'webm' as const,durationMs:900,levels:[]},transcript:null,error:null,messageId:null,updatedAt:'now'}}
  await storage.store.reserve(record);await storage.blobs.put(voiceScope(target),record.draft.recording,bytes,new AbortController().signal)
  expect(await storage.blobs.read(voiceScope(target),record.draft.recording,new AbortController().signal)).toEqual(bytes)
  expect(await foremanVoiceStore(db,{...target,model:{...target.model,model:'different'}}).row(id)).toBeNull()
  await db.execute({sql:'UPDATE desktop_foreman_voice_attempts SET cancelled=1,epoch=epoch+1 WHERE attempt_id=?',args:[id]})
  await expect(storage.store.save(record,record.draft.revision)).rejects.toThrow()
  const restored=foremanVoiceStore(db,target);expect((await restored.row(id))?.fingerprint).toBe('immutable')
 }finally{db.close()}
})
test('unpatched canonical send authority refuses instead of falling back to a late unguarded turn',async()=>{
 const send=canonicalForemanVoiceSend({} as Awaited<ReturnType<typeof desktopForeman>>)
 await expect(send({target,attemptId:'00000000-0000-4000-8000-000000000002',text:'voice',signal:new AbortController().signal,assertCurrent:async()=>{}})).rejects.toMatchObject({status:503})
})
test('cancel-before-upload is a durable tombstone, not an automatic re-upload after restart',async()=>{
 const db=createClient({url:':memory:'});try{
  await db.executeMultiple('CREATE TABLE desktop_foreman_chats(chat_id TEXT PRIMARY KEY);'+FOREMAN_VOICE_SCHEMA_SQL)
  const id='00000000-0000-4000-8000-000000000009'
  await db.execute({sql:'INSERT INTO desktop_foreman_voice_cancellations VALUES(?,?)',args:[id,'owner']})
  const storage=foremanVoiceStore(db,target,0)
  const record={fingerprint:'immutable',draft:{attemptId:id,scope:voiceScope(target),phase:'uploading' as const,revision:'00000000-0000-4000-8000-000000000003',recording:{attemptId:id,sha256:'a'.repeat(64),byteLength:3,mimeType:'audio/webm',extension:'webm' as const,transcriptionFormat:'webm' as const,durationMs:900,levels:[]},transcript:null,error:null,messageId:null,updatedAt:'now'}}
  await expect(storage.store.reserve(record)).rejects.toThrow();expect(await storage.row(id)).toBeNull()
 }finally{db.close()}
})
