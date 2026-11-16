/**
 * Agent context captured at the moment a search is issued.
 *
 * A context-aware reranker scores a candidate against more than the query
 * string: the question that motivated the whole session, and the reasoning the
 * agent produced immediately before issuing this particular query. The first is
 * supplied by the harness; the second has to be read off the live session.
 *
 * `pi` drains agent events before firing `tool_call`, so at that point
 * `ctx.sessionManager` is synchronized through the assistant message that
 * carries this tool call -- including its thinking blocks. That is the only
 * moment the trace and the query are known together, so the trace is captured
 * there and looked up by tool call id when the tool actually runs.
 */

/** Global query for the current process, i.e. the benchmark question. */
export function resolveGlobalQuery(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PI_SEARCH_GLOBAL_QUERY ?? "").trim();
}

type ThinkingBlock = { type?: string; thinking?: unknown };
type MessageLike = { role?: string; content?: unknown };
type EntryLike = { type?: string; message?: MessageLike };

/** Concatenated thinking blocks of the most recent assistant message. */
export function extractLatestThinking(entries: readonly unknown[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as EntryLike | undefined;
    if (!entry || entry.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "assistant") continue;
    if (!Array.isArray(message.content)) return "";
    const parts: string[] = [];
    for (const block of message.content as ThinkingBlock[]) {
      if (block?.type === "thinking" && typeof block.thinking === "string") {
        const text = block.thinking.trim();
        if (text) parts.push(text);
      }
    }
    // Stop at the first assistant message: older turns describe other queries.
    return parts.join("\n").trim();
  }
  return "";
}

/**
 * Trim to a character budget on a word boundary, keeping the head.
 *
 * Characters are a cheap proxy for tokens that avoids loading a tokenizer into
 * the agent process; a worker can apply an exact token cap on top. Keeping the
 * head matches how context-aware rerankers usually truncate this field in
 * training, so an over-long trace is cut the same way here.
 */
export function trimTrace(trace: string, maxChars: number): string {
  if (maxChars <= 0 || trace.length <= maxChars) return trace;
  const head = trace.slice(0, maxChars);
  const boundary = head.lastIndexOf(" ");
  return (boundary > 0 && maxChars - boundary < 40 ? head.slice(0, boundary) : head).trim();
}

/** Per-tool-call traces, written at `tool_call` and read during execution. */
export class AgentContextStore {
  private readonly traceByCallId = new Map<string, string>();

  constructor(private readonly maxTraceChars: number) {}

  record(toolCallId: string, entries: readonly unknown[]): string {
    const trace = trimTrace(extractLatestThinking(entries), this.maxTraceChars);
    if (trace) this.traceByCallId.set(toolCallId, trace);
    return trace;
  }

  /** Reads and clears: a trace belongs to exactly one tool call. */
  take(toolCallId: string): string {
    const trace = this.traceByCallId.get(toolCallId) ?? "";
    this.traceByCallId.delete(toolCallId);
    return trace;
  }

  get size(): number {
    return this.traceByCallId.size;
  }
}
