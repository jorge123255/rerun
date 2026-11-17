/**
 * The turn context the engine appends to a user message before the model reads it: the memories
 * recalled for that message and the exact time of the turn. It travels as its own text part, marked
 * so the chat never shows it and the search index never holds it, and it is persisted with the
 * message: the history the next turn replays is then byte for byte what the provider already cached.
 */
export const CONTEXT_PART_OPTIONS = { rerun: { context: true } } as const;

export type ContextTextPart = {
  type: "text";
  text: string;
  providerOptions: typeof CONTEXT_PART_OPTIONS;
};

export function contextTextPart(text: string): ContextTextPart {
  return { type: "text", text, providerOptions: CONTEXT_PART_OPTIONS };
}

export function isContextPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const options = (
    part as { providerOptions?: { rerun?: { context?: unknown } } }
  ).providerOptions;
  return options?.rerun?.context === true;
}

/** The text of a message as the user wrote it: a string as is, text parts without the context ones. */
export function visibleText(content: unknown, separator: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part) =>
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        !isContextPart(part),
    )
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .filter(Boolean)
    .join(separator);
}

/** The context parts of a message, in order: what the engine added to a turn besides the user's words. */
export function contextTexts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(isContextPart)
    .map((part) => String((part as { text?: unknown }).text ?? ""));
}
