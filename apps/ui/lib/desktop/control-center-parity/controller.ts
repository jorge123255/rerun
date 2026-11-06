import type {ParityActions,ParityCommand,ParityPage} from './types'
import {intentIsCurrent} from './authority'
export type ParityControllerState={open:boolean;pages:ParityPage[];query:string;busy:boolean;notice:string|null;version:number}
export function createParityController(actions:ParityActions){
 let state:ParityControllerState={open:false,pages:[{kind:'root'}],query:'',busy:false,notice:null,version:0},controller:AbortController|null=null
 const listeners=new Set<()=>void>()
 const update=(patch:Partial<ParityControllerState>)=>{state={...state,...patch};for(const listener of listeners)listener()}
 const invalidate=()=>{controller?.abort();controller=null;return state.version+1}
 return {
  subscribe(listener:()=>void){listeners.add(listener);return ()=>{listeners.delete(listener)}},getSnapshot:()=>state,
  open(){update({open:true,pages:[{kind:'root'}],query:'',busy:false,notice:null,version:invalidate()})},
  close(){update({open:false,busy:false,version:invalidate()})},
  query(query:string){update({query:query.slice(0,2000),notice:null,busy:false,version:invalidate()})},
  drill(page:ParityPage){update({pages:[...state.pages,page],query:'',notice:null,busy:false,version:invalidate()})},
  back(){update({pages:state.pages.length>1?state.pages.slice(0,-1):state.pages,query:'',notice:null,busy:false,version:invalidate()})},
  async execute(command:ParityCommand){
   if(!state.open||state.busy||command.disabledReason)return false
   const version=state.version,operation=new AbortController();controller=operation
   // UI and search results are data. Snapshot the target before the first await.
   const intent=structuredClone(command.intent)
   update({busy:true,notice:null})
   try{
    const snapshot=await actions.read(operation.signal)
    if(operation.signal.aborted||version!==state.version||!state.open)return false
    const capability=actions.capability(intent,snapshot)
    if(!intentIsCurrent(intent,snapshot)||capability.state!=='ready')throw new Error('Command no longer available')
    await actions.dispatch(intent,operation.signal)
    if(operation.signal.aborted||version!==state.version)return false
    update({open:false,busy:false});return true
   }catch{
    if(!operation.signal.aborted&&version===state.version)update({busy:false,notice:'This command changed or could not open. Refresh the list and try again.'})
    return false
   }finally{if(controller===operation)controller=null}
  },
 }
}
export type ParityController=ReturnType<typeof createParityController>
