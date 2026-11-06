import type {DesktopComputerLauncherApp as App,DesktopComputerLauncherAvailability as Availability,DesktopComputerLauncherState as State} from '@rerun/contracts'
const reasons:Record<State,string>={ready:'Open on this coworker’s isolated Linux screen.', 'permission-off':'Enable computer control and this app’s separate launcher permission.', 'runtime-unavailable':'The isolated screen runtime is unavailable.', 'app-missing':'This app is not installed in the isolated guest.',busy:'The screen is busy or the user is driving it.',timeout:'The app did not become visible before the deadline.',interrupted:'The launcher attempt was interrupted; it was not replayed.',refused:'This launcher request is unavailable.'}
export function launcherAvailability(app:App,state:State):Availability{return {app,label:app==='terminal'?'Terminal':'Files',state,reason:reasons[state]}}
export const COMPUTER_LAUNCHER_DESCRIPTION='Open Terminal or Files inside this coworker’s isolated Linux guest, or bring its existing window to the front. Opens in the guest workspace and returns a fresh screenshot. Each app requires its separate launcher permission and computer control. This does not open Mac apps or access Mac workspace files.'
export type LauncherUiCallbacks={onOpen:(app:App)=>Promise<void>;onRefresh:()=>Promise<Availability[]>}

export function createLauncherAvailability(read:()=>Promise<{computer:boolean;terminalLaunch:boolean;filesLaunch:boolean;runtimeAvailable:boolean;busy:boolean;terminalInstalled:boolean;filesInstalled:boolean}>){
    return async():Promise<Availability[]>=>{
        const state=await read()
        return (['terminal','files'] as const).map(app=>launcherAvailability(app,
            !state.computer||!(app==='terminal'?state.terminalLaunch:state.filesLaunch)?'permission-off':
            !state.runtimeAvailable?'runtime-unavailable':state.busy?'busy':
            !(app==='terminal'?state.terminalInstalled:state.filesInstalled)?'app-missing':'ready'))
    }
}
