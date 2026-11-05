import 'server-only'
import {createCipheriv,createDecipheriv,createHmac,randomBytes} from 'node:crypto'
import type {Client,Row} from '@libsql/client'
import type {DesktopServiceHealth} from '@rerun/contracts'
import type {ServicePlan} from './compiler'
export type OwnedSkill={slug:string;directoryIdentity:string;manifestVersion:string}
export type ServiceInstall={owner:string;engineId:string;key:string;id:string;revision:string;state:'preparing'|'ready'|'error'|'disconnected'|'removing';plan:ServicePlan;skills:OwnedSkill[];toolNames:string[];health:DesktopServiceHealth;healthLaunch:string|null;installedAt:string;configured:boolean}
export function serviceStore(db:Client,keyReader:()=>Buffer){
 const aad=(owner:string,id:string)=>Buffer.from(JSON.stringify(['desktop-service-bearer-v1',owner,id]))
 function seal(owner:string,id:string,value:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyReader(),iv);cipher.setAAD(aad(owner,id));const bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64')}
 function open(owner:string,id:string,value:string){const bytes=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',keyReader(),bytes.subarray(0,12));cipher.setAAD(aad(owner,id));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8')}
 function decode(row:Row):ServiceInstall{if(Number(row.schema_version)!==1)throw new Error('Unsupported service installation version');return {owner:String(row.owner),engineId:String(row.engine_id),key:String(row.key),id:String(row.id),revision:String(row.revision),state:String(row.state) as ServiceInstall['state'],plan:JSON.parse(String(row.plan)),skills:JSON.parse(String(row.skills)),toolNames:JSON.parse(String(row.tool_names)),health:JSON.parse(String(row.health)),healthLaunch:row.health_launch?String(row.health_launch):null,installedAt:String(row.installed_at),configured:!!row.bearer}}
 async function read(owner:string,key:string){const row=(await db.execute({sql:'SELECT * FROM desktop_service_installs WHERE owner=? AND key=?',args:[owner,key]})).rows[0];return row?decode(row):null}
 return {db,read,
  async list(owner:string){const rows=(await db.execute({sql:'SELECT * FROM desktop_service_installs WHERE owner=? ORDER BY installed_at DESC LIMIT 65',args:[owner]})).rows;if(rows.length>64)throw new Error('Too many service installations');return rows.map(decode)},
  digest(owner:string,value:unknown){return createHmac('sha256',keyReader()).update(JSON.stringify([owner,value])).digest('hex')},
  async credential(owner:string,id:string){const row=(await db.execute({sql:'SELECT bearer FROM desktop_service_installs WHERE owner=? AND id=?',args:[owner,id]})).rows[0];return row?.bearer?open(owner,id,String(row.bearer)):''},
  async create(record:ServiceInstall,bearer:string){await db.execute({sql:'INSERT INTO desktop_service_installs(owner,key,id,engine_id,slug,method_id,revision,state,plan,bearer,skills,health,installed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',args:[record.owner,record.key,record.id,record.engineId,record.plan.slug,record.plan.methodId,record.revision,record.state,JSON.stringify(record.plan),bearer?seal(record.owner,record.id,bearer):null,JSON.stringify(record.skills),JSON.stringify(record.health),record.installedAt]})},
  async update(record:ServiceInstall,expectedRevision:string,bearer?:string){const result=await db.execute({sql:`UPDATE desktop_service_installs SET revision=?,state=?,plan=?,bearer=${bearer===undefined?'bearer':'?'},skills=?,tool_names=?,health=?,health_launch=? WHERE owner=? AND key=? AND id=? AND revision=?`,args:[record.revision,record.state,JSON.stringify(record.plan),...(bearer===undefined?[]:[bearer?seal(record.owner,record.id,bearer):null]),JSON.stringify(record.skills),JSON.stringify(record.toolNames),JSON.stringify(record.health),record.healthLaunch,record.owner,record.key,record.id,expectedRevision]});if(result.rowsAffected!==1)throw new Error('Service revision conflict')},
  async remove(record:ServiceInstall){const result=await db.execute({sql:'DELETE FROM desktop_service_installs WHERE owner=? AND key=? AND id=? AND revision=?',args:[record.owner,record.key,record.id,record.revision]});if(result.rowsAffected!==1)throw new Error('Service revision conflict')},
 }
}
export type ServiceStore=ReturnType<typeof serviceStore>
