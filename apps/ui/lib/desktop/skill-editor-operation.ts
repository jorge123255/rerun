export function skillEditorOperationApplies(
    state: { mounted: boolean; generation: number; owner: string },
    captured: { generation: number; owner: string },
): boolean {
    return state.mounted && state.generation === captured.generation && state.owner === captured.owner
}
