import {createClient} from '@libsql/client'
import {afterEach,expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
import {desktopServicesSchema} from './schema'
import {serviceStore,type ServiceInstall} from './store'
const clients:ReturnType<typeof createClient>[]=[]
afterEach(()=>{for(const db of clients.splice(0))db.close()})
it('encrypts a fixture token with owner/installation AAD and keeps projections and receipt digests secret-free',async()=>{
 const db=createClient({url:'file::memory:'});clients.push(db);await db.executeMultiple("CREATE TABLE desktop_agents(id TEXT PRIMARY KEY);INSERT INTO desktop_agents VALUES('owner');"+desktopServicesSchema)
 const store=serviceStore(db,()=>Buffer.alloc(32,9)),fixture='fixture-only-never-a-real-key'
 const record:ServiceInstall={owner:'owner',engineId:'engine',key:'fixture',id:crypto.randomUUID(),revision:crypto.randomUUID(),state:'preparing',plan:{slug:'fixture',key:'fixture',name:'Fixture',category:'dev',icon:null,methodId:'token',serverName:'fixture',url:'https://example.com/mcp',secretInput:'TOKEN',skills:[]},skills:[],toolNames:[],health:{state:'unchecked'},healthLaunch:null,installedAt:new Date().toISOString(),configured:true}
 await store.create(record,fixture)
 expect(await store.credential('owner',record.id)).toBe(fixture)
 expect(JSON.stringify(await store.list('owner'))).not.toContain(fixture)
 expect(String((await db.execute('SELECT bearer FROM desktop_service_installs')).rows[0].bearer)).not.toContain(fixture)
 expect(store.digest('owner',{values:{TOKEN:fixture}})).not.toContain(fixture)
 expect(await store.list('other')).toEqual([])
 const disconnected={...record,revision:crypto.randomUUID(),state:'disconnected' as const,configured:false}
 await store.update(disconnected,record.revision,'')
 expect(await store.credential('owner',record.id)).toBe('')
 await expect(store.update(record,record.revision)).rejects.toThrow('revision')
})
