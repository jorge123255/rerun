export const desktopComputerLauncherApps = ['terminal', 'files'] as const
export type DesktopComputerLauncherApp = typeof desktopComputerLauncherApps[number]
export type DesktopComputerLauncherRequest = { app: DesktopComputerLauncherApp }
export type DesktopComputerLauncherOperation = {
    requestId: string; agentId: string; sessionId: string; runId: string;
    generation: string; app: DesktopComputerLauncherApp;
}
export type DesktopComputerLauncherState = 'ready' | 'permission-off' | 'runtime-unavailable' | 'app-missing' | 'busy' | 'timeout' | 'interrupted' | 'refused'
export type DesktopComputerLauncherAvailability = {
    app: DesktopComputerLauncherApp; label: 'Terminal' | 'Files'; state: DesktopComputerLauncherState; reason: string;
}
export type DesktopComputerLauncherOutcome = {
    requestId: string; app: DesktopComputerLauncherApp;
    status: 'opened' | 'focused' | 'interrupted' | 'app-missing' | 'timeout';
    acknowledged: boolean;
    frame?: { screenshotId: string; width: number; height: number; mediaType: 'image/jpeg' };
}
