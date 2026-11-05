'use client'
import {useCallback,useEffect,useRef,useState} from 'react'
import {SERVICE_CATEGORIES,SERVICE_CATEGORY_LABELS} from '@rerun/contracts'
import {HScrollFade} from '@rerun/ui/primitives'
import {ServiceSetupDriverProvider} from '@/components/services/service-setup-driver'
import {ServiceList} from '@/components/services/ServiceList'
import {PanelSteps} from '@/components/ui/panel-steps'
import {PanelList,PanelScroller,PanelSection} from '@/components/ui/panel-list'
import {PanelRow} from '@/components/ui/panel-row'
import {PanelDeleteButton,PanelEditorBody,PanelEditorHeader,PanelEditorShell} from '@/components/ui/panel-editor'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import {Chip} from '@/components/ui/chip'
import {Icon} from '@/components/ui/icon'
import {EmptyState} from '@/components/ui/empty-state'
import {SkeletonPanelRows} from '@/components/ui/skeleton'
import {UnplugIcon} from '@/lib/icons'
import {serviceIconProps} from '@/lib/services/icons'
import type {ServiceSearchResult} from '@/lib/services/types'
import {createDesktopServicesClient,type DesktopServicesClient,type DesktopInstalledService,type DesktopServiceDetails} from '@/lib/desktop/services-client'
import {DesktopServiceConfigForm} from './DesktopServiceConfigForm'
export function DesktopCoworkerServices({agentId}:{agentId:string}){return <Services key={agentId} agentId={agentId}/>}
function Services({agentId}:{agentId:string}){
 const [client,setClient]=useState<DesktopServicesClient|null>(null),[installed,setInstalled]=useState<DesktopInstalledService[]>([]),[catalog,setCatalog]=useState<ServiceSearchResult[]>([]),[total,setTotal]=useState(0),[query,setQuery]=useState(''),[category,setCategory]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState(''),[detail,setDetail]=useState<DesktopServiceDetails|null>(null),[opening,setOpening]=useState(false),[busy,setBusy]=useState(false)
 const source=useRef<DesktopServicesClient|null>(null),loadEpoch=useRef(0),navigation=useRef(0),mutation=useRef(false),catalogSize=useRef(0)
 useEffect(()=>{const next=createDesktopServicesClient(agentId);source.current=next;setClient(next);return()=>{source.current=null;loadEpoch.current++;navigation.current++;next.dispose()}},[agentId])
 const load=useCallback(async(append=false)=>{
  if(!client)return
  const epoch=++loadEpoch.current;setLoading(true)
  try{
   const [rows,page]=await Promise.all([client.installed(),client.catalog(query,category,append?catalogSize.current:0)])
   if(source.current!==client||epoch!==loadEpoch.current)return
   setInstalled(rows);setCatalog(previous=>{const next=append?[...previous,...page.services.map(row=>({...row,setup:'needs_config' as const,setupReason:'Choose a supported local method.'}))]:page.services.map(row=>({...row,setup:'needs_config' as const,setupReason:'Choose a supported local method.'}));catalogSize.current=next.length;return next});setTotal(page.total);setError('')
  }catch{if(source.current===client&&epoch===loadEpoch.current)setError('Could not load apps. Retry to read the local catalog and connection state.')}
  finally{if(source.current===client&&epoch===loadEpoch.current)setLoading(false)}
 },[client,query,category])
 useEffect(()=>{if(!client)return;loadEpoch.current++;catalogSize.current=0;setCatalog([]);setLoading(true);const timer=setTimeout(()=>{void load()},150);return()=>clearTimeout(timer)},[client,load])
 async function open(slug:string){
  if(!client||mutation.current)return
  const epoch=++navigation.current;setOpening(true);setError('')
  try{const next=await client.details(slug);if(source.current===client&&navigation.current===epoch)setDetail(next)}catch{if(source.current===client&&navigation.current===epoch)setError('Could not load this app’s details.')}
  finally{if(source.current===client&&navigation.current===epoch)setOpening(false)}
 }
 async function changed(){if(!client||!detail)return;const epoch=navigation.current;const next=await client.details(detail.slug);if(source.current!==client||navigation.current!==epoch)return;setDetail(next);await load()}
 async function action(kind:'probe'|'disconnect'|'remove'){
  if(!client||!detail?.installation||mutation.current)return
  mutation.current=true;setBusy(true);setError('');const epoch=navigation.current
  try{
   const result=await client.mutate(kind,detail.installation)
   if(source.current!==client||navigation.current!==epoch)return
   if(kind==='remove'&&result.status==='removed'){navigation.current++;setDetail(null)}else await changed()
   await load()
  }catch{if(source.current===client&&navigation.current===epoch)setError('Operation refused or acknowledgement unknown. Refresh connection state before retrying.')}
  finally{mutation.current=false;if(source.current===client)setBusy(false)}
 }
 const health=(row:DesktopInstalledService)=>row.health.state==='healthy'&&row.installed?'Connected (last check)':row.health.state==='unchecked'?'Unchecked':row.health.state==='disconnected'?'Disconnected':'Connection failed'
 if(!client)return <SkeletonPanelRows rows={6}/>
 return <ServiceSetupDriverProvider value={client.driver}><PanelSteps stepKey={detail?'setup':'list'} depth={detail?1:0}>
  {detail?<PanelEditorShell><PanelEditorHeader title={detail.name} onBack={busy?undefined:()=>{navigation.current++;setDetail(null)}}/><PanelEditorBody>
   {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
   <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">{detail.description||detail.summary}</p>
   <p className="text-xs text-muted-foreground">{detail.localLimitations}</p>
   <Button size="sm" variant="outline" disabled={busy} onClick={()=>changed().catch(()=>setError('Could not refresh connection state.'))}>Refresh connection state</Button>
   {detail.installation&&<div className="space-y-2"><p className="text-xs">{health(detail.installation)}{detail.installation.health.checkedAt?` · ${detail.installation.health.checkedAt}`:''}</p><p className="text-xs text-muted-foreground">{detail.installation.health.message}</p><div className="flex flex-wrap gap-2">
    <Button size="sm" variant="outline" disabled={busy||detail.installation.health.state==='disconnected'} onClick={()=>action('probe')}>Probe connection</Button>
    <Button size="sm" variant="ghost" disabled={busy} onClick={()=>action('disconnect')}>Disconnect</Button>
    <PanelDeleteButton label={`Uninstall ${detail.name}`} disabled={busy} busy={busy} onClick={()=>action('remove')} confirmTitle={`Uninstall ${detail.name}?`} confirmDescription="The coworker loses this installation’s owned resources and tools. Local credentials are removed; the remote API key is not revoked." confirmLabel="Uninstall"/>
   </div></div>}
   <DesktopServiceConfigForm key={`${agentId}/${detail.slug}/${detail.installation?.revision??'new'}`} agentId={agentId} details={detail} localDriver={client.driver} onChanged={changed} onBusy={value=>{mutation.current=value;setBusy(value)}}/>
  </PanelEditorBody></PanelEditorShell>:<div className="flex flex-col h-full min-w-0">
   <div className="space-y-2 border-b p-3"><Input className="h-8 text-sm" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search apps…"/><HScrollFade className="flex gap-1"><Chip selected={!category} onClick={()=>setCategory('')}>All</Chip>{SERVICE_CATEGORIES.map(item=><Chip key={item} selected={category===item} onClick={()=>setCategory(item)}>{SERVICE_CATEGORY_LABELS[item]}</Chip>)}</HScrollFade></div>
   <PanelScroller className="space-y-4">
    {error&&<div className="space-y-2"><p role="alert" className="text-xs text-destructive">{error}</p><Button size="sm" variant="outline" onClick={()=>load()}>Retry</Button></div>}
    {opening&&<p role="status" className="text-xs text-muted-foreground">Loading app details…</p>}
    <PanelSection label="Installed">{loading&&!installed.length?<SkeletonPanelRows rows={3} leading/>:installed.length?<PanelList>{installed.map(row=><PanelRow key={row.key} title={row.name} leading={<Icon {...serviceIconProps(row.icon,row.category)} size="sm"/>} description={health(row)} onClick={()=>open(row.key)} actions={<Button size="sm" variant="outline" onClick={()=>open(row.key)}>Configure</Button>}/>)}</PanelList>:!error&&<EmptyState icon={UnplugIcon} title="No apps installed" description="Add an app from Discover to extend this coworker’s tools."/>}</PanelSection>
    <PanelSection label="Discover">{loading&&!catalog.length?<SkeletonPanelRows rows={6} leading/>:catalog.length?<ServiceList services={catalog} onInstall={slug=>open(slug)}/>:!error&&<EmptyState className="py-8" icon={UnplugIcon} title="No apps found" description="We could not find an app matching your search."/>}{catalog.length<total&&<Button size="sm" variant="outline" disabled={loading} onClick={()=>load(true)}>{loading?'Loading…':'Load more apps'}</Button>}</PanelSection>
   </PanelScroller>
  </div>}
 </PanelSteps></ServiceSetupDriverProvider>
}
