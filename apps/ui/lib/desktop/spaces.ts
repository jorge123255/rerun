import { z } from 'zod'
import { MIN_CONTAINER_SPAN } from '@rerun/ui/iso-grid/iso'

// Boxes are board rectangles only. Coordinates are absolute, inclusive grid cells;
// a coworker occupies the 2 × 2 cells starting at its col/row anchor.
export const DESKTOP_SPACE_COORDINATE_LIMIT = 1_000_000
export const desktopSpaceCoordinateSchema = z.number().int().min(-DESKTOP_SPACE_COORDINATE_LIMIT).max(DESKTOP_SPACE_COORDINATE_LIMIT)
export const desktopSpacePositionSchema = z.object({ col: desktopSpaceCoordinateSchema, row: desktopSpaceCoordinateSchema }).strict()
export const desktopSpaceRectSchema = z.object({
    col_start: desktopSpaceCoordinateSchema,
    row_start: desktopSpaceCoordinateSchema,
    col_end: desktopSpaceCoordinateSchema,
    row_end: desktopSpaceCoordinateSchema,
}).strict().refine(rect => rect.col_end - rect.col_start >= MIN_CONTAINER_SPAN - 1 && rect.row_end - rect.row_start >= MIN_CONTAINER_SPAN - 1,
    'A Box must have ordered bounds and be at least four cells wide and high.')
export const desktopSpaceNameSchema = z.string().trim().min(1).max(60)
export const desktopSpaceSideSchema = z.enum(['top-right', 'bottom-right', 'bottom-left', 'top-left'])
export const desktopSpaceSchema = z.object({
    id: z.string().uuid(), name: desktopSpaceNameSchema,
    col_start: desktopSpaceCoordinateSchema, row_start: desktopSpaceCoordinateSchema,
    col_end: desktopSpaceCoordinateSchema, row_end: desktopSpaceCoordinateSchema,
}).strict().refine(rect => rect.col_end - rect.col_start >= MIN_CONTAINER_SPAN - 1 && rect.row_end - rect.row_start >= MIN_CONTAINER_SPAN - 1)
export const desktopSpacePlacementSchema = z.object({
    agentId: z.string().uuid(), spaceId: z.string().uuid(),
    col: desktopSpaceCoordinateSchema, row: desktopSpaceCoordinateSchema,
}).strict()
export const desktopBoardStateSchema = z.object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    spaces: z.array(desktopSpaceSchema), placements: z.array(desktopSpacePlacementSchema),
}).strict()
export const desktopSpaceCommandSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('create'), name: desktopSpaceNameSchema, sourceId: z.string().uuid().optional(), side: desktopSpaceSideSchema.optional() }).strict(),
    z.object({ kind: z.literal('rename'), spaceId: z.string().uuid(), name: desktopSpaceNameSchema }).strict(),
    z.object({ kind: z.literal('delete'), spaceId: z.string().uuid(), confirmationName: z.string().max(120) }).strict(),
    z.object({ kind: z.literal('move-space'), spaceId: z.string().uuid(), rect: desktopSpaceRectSchema }).strict(),
    z.object({ kind: z.literal('resize-space'), spaceId: z.string().uuid(), rect: desktopSpaceRectSchema }).strict(),
    z.object({ kind: z.literal('move-agent'), agentId: z.string().uuid(), spaceId: z.string().uuid(), position: desktopSpacePositionSchema.optional() }).strict(),
]).refine(command => command.kind !== 'create' || Boolean(command.sourceId) === Boolean(command.side), 'Choose both a source Box and a side.')
export const desktopSpaceWriteSchema = z.object({
    requestId: z.string().uuid(), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), command: desktopSpaceCommandSchema,
}).strict()

export type DesktopSpace = z.infer<typeof desktopSpaceSchema>
export type DesktopSpacePlacement = z.infer<typeof desktopSpacePlacementSchema>
export type DesktopBoardState = z.infer<typeof desktopBoardStateSchema>
export type DesktopSpaceCommand = z.infer<typeof desktopSpaceCommandSchema>
export type DesktopSpaceWrite = z.infer<typeof desktopSpaceWriteSchema>
