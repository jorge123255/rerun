'use client'
import type {ComponentProps} from 'react'
import {ControlCenterView} from '@/components/control-center/ControlCenterView'
import type {ControlSection} from '@/components/control-center/types'
export type DesktopControlCenterParityViewProps=ComponentProps<typeof ControlCenterView>&{busy?:boolean;notice?:string|null}
export function DesktopControlCenterParityView({busy=false,notice,...props}:DesktopControlCenterParityViewProps){
 const sections:ControlSection[]=props.sections.map(section=>({...section,rows:section.rows.map(row=>({...row,disabledReason:busy?row.disabledReason??'Opening…':row.disabledReason,onSelect:()=>{if(!busy&&!row.disabledReason)row.onSelect()},onDrill:!busy&&!row.disabledReason?row.onDrill:undefined}))}))
 return <ControlCenterView {...props} sections={sections} resultsHint={notice??(busy?'Opening…':props.resultsHint)}/>
}
