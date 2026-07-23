export const PREBUILT_INDEX_CONTENTS_URL =
  "https://api.github.com/repos/castorini/prebuilt-indexes/contents/lucene";
export const ANSERINI_TOOLS_RAW_ROOT =
  "https://raw.githubusercontent.com/castorini/anserini-tools/master/topics-and-qrels";

export type PrebuiltIndex = {
  name: string;
  type: string;
  corpus: string;
  corpus_index: string;
  description: string;
  filename: string;
  readme: string;
  urls: string[];
  md5: string;
  size: number;
  documents?: number;
};

export type AnseriniTopic = {
  id: string;
  path: string;
  readerClass: string;
};

export type AnseriniQrels = {
  id: string;
  path: string;
  aliases: string[];
};

export type PrebuiltCatalog = {
  indexes: PrebuiltIndex[];
  topics: AnseriniTopic[];
  qrels: AnseriniQrels[];
};

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type GithubContentEntry = {
  name?: unknown;
  type?: unknown;
  download_url?: unknown;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireMd5(value: unknown, label: string): string {
  const md5 = requireString(value, label);
  if (!/^[a-f0-9]{32}$/i.test(md5)) throw new Error(`${label} must be a 32-character MD5 digest`);
  return md5.toLowerCase();
}

async function fetchJson(fetchImpl: FetchLike, url: string, label: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "piika-prebuilt-catalog",
    },
  });
  if (!response.ok) {
    throw new Error(`${label} request failed (${response.status} ${response.statusText}): ${url}`);
  }
  return await response.json();
}

function parseIndex(value: unknown, source: string, position: number): PrebuiltIndex {
  const row = asRecord(value, `${source}[${position}]`);
  const urls = row.urls;
  if (
    !Array.isArray(urls) ||
    urls.length === 0 ||
    !urls.every((url) => typeof url === "string" && url.length > 0)
  ) {
    throw new Error(`${source}[${position}].urls must be a non-empty string array`);
  }
  const size = row.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    throw new Error(`${source}[${position}].size must be a non-negative number`);
  }
  const corpusIndex = requireString(row.corpus_index, `${source}[${position}].corpus_index`);
  return {
    name: requireString(row.name, `${source}[${position}].name`),
    type: requireString(row.type, `${source}[${position}].type`),
    corpus: typeof row.corpus === "string" && row.corpus.trim() ? row.corpus : corpusIndex,
    corpus_index: corpusIndex,
    description: typeof row.description === "string" ? row.description : "",
    filename: requireString(row.filename, `${source}[${position}].filename`),
    readme: typeof row.readme === "string" ? row.readme : "",
    urls,
    md5: requireMd5(row.md5, `${source}[${position}].md5`),
    size,
    documents: typeof row.documents === "number" ? row.documents : undefined,
  };
}

function parseTopics(value: unknown): AnseriniTopic[] {
  return Object.entries(asRecord(value, "Anserini topics metadata"))
    .map(([id, raw]) => {
      const row = asRecord(raw, `topic ${id}`);
      return {
        id,
        path: requireString(row.path, `topic ${id}.path`),
        readerClass: requireString(row.reader_class, `topic ${id}.reader_class`),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function parseQrels(value: unknown, aliasesValue: unknown): AnseriniQrels[] {
  const aliases = asRecord(aliasesValue, "Anserini qrels aliases metadata");
  return Object.entries(asRecord(value, "Anserini qrels metadata"))
    .map(([id, path]) => {
      const rawAliases = aliases[id];
      if (
        rawAliases !== undefined &&
        (!Array.isArray(rawAliases) || !rawAliases.every((alias) => typeof alias === "string"))
      ) {
        throw new Error(`qrels aliases for ${id} must be a string array`);
      }
      return {
        id,
        path: requireString(path, `qrels ${id}`),
        aliases: rawAliases === undefined ? [] : (rawAliases as string[]),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Loads and validates the current Castorini index, topic, and qrels catalogs. */
export async function loadPrebuiltCatalog(options?: {
  fetchImpl?: FetchLike;
  indexContentsUrl?: string;
  anseriniToolsRawRoot?: string;
}): Promise<PrebuiltCatalog> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const indexContentsUrl = options?.indexContentsUrl ?? PREBUILT_INDEX_CONTENTS_URL;
  const rawRoot = options?.anseriniToolsRawRoot ?? ANSERINI_TOOLS_RAW_ROOT;
  const contents = await fetchJson(fetchImpl, indexContentsUrl, "Prebuilt index catalog");
  if (!Array.isArray(contents)) {
    throw new Error("Prebuilt index catalog response must be an array");
  }
  const metadataFiles = (contents as GithubContentEntry[])
    .filter(
      (entry) =>
        entry.type === "file" &&
        typeof entry.name === "string" &&
        entry.name.endsWith(".json") &&
        typeof entry.download_url === "string",
    )
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  if (metadataFiles.length === 0) {
    throw new Error("Prebuilt index catalog did not contain any Lucene metadata JSON files");
  }

  const [indexGroups, topicsValue, qrelsValue, aliasesValue] = await Promise.all([
    Promise.all(
      metadataFiles.map(async (entry) => {
        const source = requireString(entry.name, "prebuilt metadata filename");
        const value = await fetchJson(
          fetchImpl,
          requireString(entry.download_url, `${source}.download_url`),
          source,
        );
        if (!Array.isArray(value)) throw new Error(`${source} must contain a JSON array`);
        return value.map((row, position) => parseIndex(row, source, position));
      }),
    ),
    fetchJson(fetchImpl, `${rawRoot}/_metadata_topics.json`, "Anserini topics metadata"),
    fetchJson(fetchImpl, `${rawRoot}/_metadata_qrels.json`, "Anserini qrels metadata"),
    fetchJson(
      fetchImpl,
      `${rawRoot}/_metadata_qrels_aliases.json`,
      "Anserini qrels aliases metadata",
    ),
  ]);

  const indexes = indexGroups.flat().sort((left, right) => left.name.localeCompare(right.name));
  const duplicate = indexes.find(
    (entry, index) => index > 0 && indexes[index - 1].name === entry.name,
  );
  if (duplicate) throw new Error(`Duplicate prebuilt index id: ${duplicate.name}`);

  return {
    indexes,
    topics: parseTopics(topicsValue),
    qrels: parseQrels(qrelsValue, aliasesValue),
  };
}

export function findPrebuiltIndex(catalog: PrebuiltCatalog, name: string): PrebuiltIndex {
  const entry = catalog.indexes.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Unknown prebuilt index: ${name}`);
  return entry;
}

export function findAnseriniTopic(catalog: PrebuiltCatalog, id: string): AnseriniTopic {
  const entry = catalog.topics.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown Anserini topics id: ${id}`);
  return entry;
}

export function findAnseriniQrels(catalog: PrebuiltCatalog, id: string): AnseriniQrels {
  const entry = catalog.qrels.find(
    (candidate) => candidate.id === id || candidate.aliases.includes(id),
  );
  if (!entry) throw new Error(`Unknown Anserini qrels id or alias: ${id}`);
  return entry;
}
