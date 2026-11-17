/**
 * Anthropic caches a prompt only where asked, and OpenRouter forwards the ask in the OpenAI chat
 * format as a `cache_control` on a content block. The hub and the engine both send that format,
 * so they share one rewrite: every system message gets a breakpoint of its own (the stable block
 * and the volatile block of the system prompt), and the top-level marker keeps caching the prefix
 * up to the last message, whatever its role, so each step of a run reads what the step before it
 * wrote. The hour-long TTL covers a user who answers between five minutes and an hour later.
 */
export const ANTHROPIC_CACHE_CONTROL = {
  type: "ephemeral",
  ttl: "1h",
} as const;

type ChatContentPart = {
  type: string;
  text?: string;
  cache_control?: unknown;
} & Record<string, unknown>;
type ChatMessage = { role?: unknown; content?: unknown } & Record<
  string,
  unknown
>;
export type ChatBody = { messages?: unknown; cache_control?: unknown } & Record<
  string,
  unknown
>;

function withBreakpoint(content: unknown): unknown {
  if (typeof content === "string")
    return [
      { type: "text", text: content, cache_control: ANTHROPIC_CACHE_CONTROL },
    ];
  if (!Array.isArray(content)) return content;
  const last = content
    .map((part, i) =>
      part &&
      typeof part === "object" &&
      (part as ChatContentPart).type === "text"
        ? i
        : -1,
    )
    .filter((i) => i >= 0)
    .at(-1);
  if (last === undefined) return content;
  return content.map((part, i) =>
    i === last
      ? { ...(part as ChatContentPart), cache_control: ANTHROPIC_CACHE_CONTROL }
      : part,
  );
}

function isSystem(message: unknown): message is ChatMessage {
  return (
    !!message &&
    typeof message === "object" &&
    (message as ChatMessage).role === "system"
  );
}

export function hasCacheBreakpoints(body: ChatBody): boolean {
  return (
    Array.isArray(body.messages) &&
    body.messages.some(
      (message) =>
        isSystem(message) &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            part &&
            typeof part === "object" &&
            "cache_control" in (part as object),
        ),
    )
  );
}

export function withAnthropicCacheBreakpoints(body: ChatBody): ChatBody {
  if (!Array.isArray(body.messages))
    return { ...body, cache_control: ANTHROPIC_CACHE_CONTROL };
  const messages = hasCacheBreakpoints(body)
    ? body.messages
    : body.messages.map((message) =>
        isSystem(message)
          ? { ...message, content: withBreakpoint(message.content) }
          : message,
      );
  return { ...body, messages, cache_control: ANTHROPIC_CACHE_CONTROL };
}
