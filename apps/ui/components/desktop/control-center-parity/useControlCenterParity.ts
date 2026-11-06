'use client'
import {useEffect,useMemo,useRef,useSyncExternalStore,useLayoutEffect} from 'react'
import {createParityController} from '@/lib/desktop/control-center-parity/controller'
import type {ParityActions} from '@/lib/desktop/control-center-parity/types'
export function useControlCenterParity(actions:ParityActions,open:boolean,selectionScope:string){
 const latest=useRef(actions);latest.current=actions
 const controller=useMemo(()=>createParityController({read:signal=>latest.current.read(signal),capability:(intent,snapshot)=>latest.current.capability(intent,snapshot),dispatch:(intent,signal)=>latest.current.dispatch(intent,signal)}),[])
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot)
 useLayoutEffect(()=>{if(open)controller.open();else controller.close()},[controller,open,selectionScope])
 useEffect(()=>()=>controller.close(),[controller])
 return {controller,state}
}
