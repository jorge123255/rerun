import { z } from 'zod'

/**
 * What a coworker's own screen and browser still need on this Mac, for the whole app rather than
 * one coworker. The screen runs in an isolated Linux container, so it needs Docker installed,
 * Docker running, and the screen image built once from the files the app ships with.
 */
export const desktopScreenSetupSchema = z.object({
    need: z.enum(['docker', 'docker-running', 'image', 'unsupported', 'nothing']),
    // Building the image: fetching the base system, installing the browser, then checking it.
    install: z.object({
        state: z.enum(['idle', 'installing', 'failed']),
        step: z.number().int().min(0).nullable(),
        steps: z.number().int().min(1).nullable(),
        error: z.enum(['offline', 'docker', 'build']).nullable(),
    }).strict(),
}).strict()
export type DesktopScreenSetup = z.infer<typeof desktopScreenSetupSchema>

export const desktopScreenSetupActionSchema = z.object({ action: z.enum(['install', 'cancel']) }).strict()
export type DesktopScreenSetupAction = z.infer<typeof desktopScreenSetupActionSchema>
