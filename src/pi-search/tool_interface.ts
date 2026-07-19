export type PiSearchToolInterface = "pi-serini-3tool" | "pyserini-rest-2tool";

export const DEFAULT_PI_SEARCH_TOOL_INTERFACE: PiSearchToolInterface = "pyserini-rest-2tool";

export function parsePiSearchToolInterface(value?: string): PiSearchToolInterface {
  const raw = value?.trim() || DEFAULT_PI_SEARCH_TOOL_INTERFACE;
  if (raw === "pi-serini-3tool" || raw === "pyserini-rest-2tool") return raw;
  throw new Error(
    `Invalid tool interface ${raw}. Expected pi-serini-3tool or pyserini-rest-2tool.`,
  );
}
