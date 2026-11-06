import {desktopServiceOAuthSnapshotSchema,type DesktopServiceOAuthAction,type DesktopServiceOAuthSnapshot} from '@rerun/contracts'
export type ServiceOAuthDriver={action:(owner:string,input:DesktopServiceOAuthAction,signal:AbortSignal)=>Promise<DesktopServiceOAuthSnapshot>}
export function serviceOAuthClient(network:typeof fetch=fetch):ServiceOAuthDriver{
 return {async action(owner,input,signal){
  const response=await network(`/api/desktop/coworkers/${encodeURIComponent(owner)}/service-oauth`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal,cache:'no-store',credentials:'same-origin',redirect:'error'})
  if(!response.ok)throw new Error('OAuth unavailable or account changed. Refresh and retry.')
  const data=await response.json() as {snapshot?:unknown}
  const snapshot=desktopServiceOAuthSnapshotSchema.parse(data.snapshot)
  if(snapshot.coworkerId!==owner)throw new Error('OAuth result belongs to another coworker')
  return snapshot
 }}
}
