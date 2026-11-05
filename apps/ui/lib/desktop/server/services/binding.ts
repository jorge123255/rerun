import 'server-only'
import type {serviceApi} from './api'
import type {serviceEngineBridge} from './bridge'
type Binding={api:ReturnType<typeof serviceApi>;bridge:ReturnType<typeof serviceEngineBridge>}
const state=globalThis as typeof globalThis&{desktopLocalServicesBinding?:Binding}
export function bindLocalServices(binding:Binding){if(state.desktopLocalServicesBinding)throw new Error('Local service authority already bound');state.desktopLocalServicesBinding=binding}
export function localServicesBinding(){if(!state.desktopLocalServicesBinding)throw new Error('Local service authority not initialized');return state.desktopLocalServicesBinding}
