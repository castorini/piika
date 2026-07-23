import { DEFAULT_PI_SEARCH_TOOL_INTERFACE, type PiSearchToolInterface } from "./tool_interface";

const ANSWER_RESPONSE_FORMAT = `Answer:
Explanation: {your explanation for your final answer. Cite supporting docids inline in square brackets [] at the end of sentences when possible, for example [123].}
Exact Answer: {your succinct, final answer}
Confidence: {your confidence score between 0% and 100%}`;

const RANKED_LIST_RESPONSE_FORMAT = `Ranked List:
1. {docid}
2. {docid}
3. {docid}`;

const SUBMIT_NOW_REMINDER = `If you later receive a user steer telling you to submit now, stop using tools immediately and answer right away with the exact final response format below. Do not do more research after that steer.`;

const BASE_WORKFLOW = `You are a research and retrieval agent using only the provided tools.`;

const TWO_TOOL_WORKFLOW = `Workflow:
1. Use search with a concise raw query string based on the original question.
2. Prefer short lexical searches over long natural-language rewrites.
3. Inspect the ranked hits returned directly by search before rewriting the query.
4. If a promising candidate document appears, inspect it with read_document.
5. Follow the read_document schema and any continuation guidance returned by the tool.
6. Use search refinements only when they add a genuinely new clue from what you already saw.
7. Every call to search and read_document must include reason as the first argument. Keep it specific, under 100 words, and focused on the clue, gap, candidate, or ranking issue.`;

const THREE_TOOL_WORKFLOW = `Workflow:
1. Use search with a concise raw query string based on the original question.
2. Prefer short lexical searches over long natural-language rewrites.
3. Browse the current ranking with read_search_results before repeatedly rewriting the query.
4. If a promising candidate document appears in the ranking, inspect it with read_document.
5. When reading a document, start with offset=1 and a moderate limit. If it is truncated and still relevant, continue reading the same document.
6. Use search refinements only when they add a genuinely new clue from what you already saw.
7. Every call to search, read_search_results, and read_document must include reason as the first argument. Keep it specific, under 100 words, and focused on the clue, gap, candidate, or ranking issue.`;

function toolWorkflow(toolInterface: PiSearchToolInterface): string {
  return toolInterface === "pyserini-rest-2tool" ? TWO_TOOL_WORKFLOW : THREE_TOOL_WORKFLOW;
}

const ANSWER_INSTRUCTIONS = `Answer output:
- Produce a concise answer supported by the documents you found.
- Cite supporting docids inline when possible.
- Keep Exact Answer directly responsive to the question.`;

function rankedListInstructions(depth: number, count?: number): string {
  const sizeInstruction = count
    ? `Return exactly ${count} unique document ids. Continue searching until you have at least ${count} plausible candidates; do not return fewer than ${count}.`
    : `Return as many relevant candidates as you can, up to ${depth} document ids.`;
  return `Ranked-list output:
- ${sizeInstruction}
- Deduplicate document ids and rank them by estimated relevance, most relevant first.
- Do not include scores, titles, snippets, citations, or explanations within the ranked list.`;
}

export type PiSearchPromptVariant = "plain_minimal";
export type PiSearchOutputMode = "answer" | "ranked_list";
export type PiSearchOutputModes = readonly PiSearchOutputMode[];
export type PiSearchPromptOptions = {
  outputMode?: PiSearchOutputMode;
  outputModes?: PiSearchOutputModes;
  toolInterface?: PiSearchToolInterface;
  rankedListDepth?: number;
  rankedListCount?: number;
};

export const DEFAULT_PI_SEARCH_OUTPUT_MODES: PiSearchOutputModes = ["answer"];

export function parsePiSearchOutputModes(value?: string): PiSearchOutputMode[] {
  const parts = (value?.trim() || "answer")
    .split(/[+,]/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const modes: PiSearchOutputMode[] = [];
  for (const part of parts) {
    if (part !== "answer" && part !== "ranked_list") {
      throw new Error(
        `Invalid output mode ${part}. Expected one or more of: answer, ranked_list (combine with +).`,
      );
    }
    if (!modes.includes(part)) modes.push(part);
  }
  if (modes.length === 0) throw new Error("At least one output mode is required.");
  return modes;
}

export function formatPiSearchOutputModes(modes: PiSearchOutputModes): string {
  return modes.join("+");
}

export function hasPiSearchOutputMode(
  modes: PiSearchOutputModes,
  mode: PiSearchOutputMode,
): boolean {
  return modes.includes(mode);
}

export function formatPiSearchPrompt(
  query: string,
  _variant: PiSearchPromptVariant = "plain_minimal",
  options?: PiSearchPromptOptions,
): string {
  const modes =
    options?.outputModes ??
    (options?.outputMode ? [options.outputMode] : DEFAULT_PI_SEARCH_OUTPUT_MODES);
  const wantsAnswer = hasPiSearchOutputMode(modes, "answer");
  const wantsRankedList = hasPiSearchOutputMode(modes, "ranked_list");
  const workflow = toolWorkflow(options?.toolInterface ?? DEFAULT_PI_SEARCH_TOOL_INTERFACE);
  const outputInstructions = [
    wantsAnswer ? ANSWER_INSTRUCTIONS : undefined,
    wantsRankedList
      ? rankedListInstructions(options?.rankedListDepth ?? 1000, options?.rankedListCount)
      : undefined,
  ].filter((instruction): instruction is string => Boolean(instruction));
  const responseSections = [
    wantsAnswer ? ANSWER_RESPONSE_FORMAT : undefined,
    wantsRankedList ? RANKED_LIST_RESPONSE_FORMAT : undefined,
  ].filter((section): section is string => Boolean(section));

  return `${BASE_WORKFLOW}

${workflow}
8. Satisfy every requested output below; use the same research pass for all outputs.
9. As soon as you have enough evidence and candidates, stop using tools and answer in plain assistant text.

${outputInstructions.join("\n\n")}

Your final response must contain exactly these sections in this order:
${responseSections.join("\n\n")}

Do not include any text before, after, or between those sections beyond the requested fields and ranked document lines.

${SUBMIT_NOW_REMINDER}

Question: ${query}`;
}

export function formatPiSearchPromptWithSuppliedContext(
  query: string,
  suppliedContext: string,
  options?: PiSearchPromptOptions,
): string {
  const modes =
    options?.outputModes ??
    (options?.outputMode ? [options.outputMode] : DEFAULT_PI_SEARCH_OUTPUT_MODES);
  const wantsAnswer = hasPiSearchOutputMode(modes, "answer");
  const wantsRankedList = hasPiSearchOutputMode(modes, "ranked_list");
  const outputInstructions = [
    wantsAnswer ? ANSWER_INSTRUCTIONS : undefined,
    wantsRankedList
      ? rankedListInstructions(options?.rankedListDepth ?? 1000, options?.rankedListCount)
      : undefined,
  ].filter((instruction): instruction is string => Boolean(instruction));
  const responseSections = [
    wantsAnswer ? ANSWER_RESPONSE_FORMAT : undefined,
    wantsRankedList ? RANKED_LIST_RESPONSE_FORMAT : undefined,
  ].filter((section): section is string => Boolean(section));
  const toolInterface = options?.toolInterface ?? DEFAULT_PI_SEARCH_TOOL_INTERFACE;
  const toolNames =
    toolInterface === "pyserini-rest-2tool"
      ? "search and read_document"
      : "search, read_search_results, and read_document";
  const browseConstraint =
    toolInterface === "pyserini-rest-2tool"
      ? ""
      : " Do not use read_search_results unless the single search result page is unusable without it.";

  return `You are a deep research agent answering a question using supplied documents and optional search tools.

Workflow:
1. First use the supplied documents below. They are already supplied documents, grouped by document group, and include docids, cited snippets, and full text. Do not search just to rediscover or re-open these supplied docs.
2. Do not assume the supplied documents are sufficient or perfectly complete.
3. Most questions should be answerable directly from the supplied documents. If they establish the requested output, use them even if one original clue is not independently proven.
4. Search budget: at most one search call total, and at most one follow-up read_document call if that search returns a specific document you need.${browseConstraint}
5. Use that limited search budget only if the supplied documents do not establish the requested output, or if one narrowly targeted lookup is likely to resolve a concrete missing link.
6. Do not perform broad searches just to verify every clue after the supplied documents already establish the result.
7. Every call to ${toolNames} must include reason as the first argument. Keep it specific, under 100 words, and focused on the clue, gap, candidate, or ranking issue.
8. Satisfy every requested output below; use the same research pass for all outputs.
9. As soon as you have enough evidence and candidates, stop using tools and answer in plain assistant text.
10. Do not mention or rely on any gold answer field; answer only from supplied or retrieved evidence.

${outputInstructions.join("\n\n")}

Your final response must contain exactly these sections in this order:
${responseSections.join("\n\n")}

Do not include any text before, after, or between those sections beyond the requested fields and ranked document lines.

${SUBMIT_NOW_REMINDER}

Question: ${query}

Supplied context:
${suppliedContext}
`;
}
