import assert from "node:assert/strict";
import test from "node:test";
import {
  findAnseriniQrels,
  findAnseriniTopic,
  findPrebuiltIndex,
  loadPrebuiltCatalog,
} from "../src/prebuilt/catalog";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

void test("prebuilt catalog discovers index metadata files and Anserini aliases", async () => {
  const responses = new Map<string, unknown>([
    [
      "https://example.test/contents",
      [
        {
          name: "inverted.json",
          type: "file",
          download_url: "https://example.test/inverted.json",
        },
        { name: "README.md", type: "file", download_url: "https://example.test/readme" },
      ],
    ],
    [
      "https://example.test/inverted.json",
      [
        {
          name: "example-index",
          type: "inverted",
          corpus: "Example Corpus",
          corpus_index: "example-corpus",
          description: "Example index",
          filename: "example.tar.gz",
          readme: "",
          urls: ["https://example.test/example.tar.gz"],
          md5: "0123456789abcdef0123456789abcdef",
          size: 42,
        },
      ],
    ],
    [
      "https://example.test/tools/_metadata_topics.json",
      {
        "example-test": {
          path: "topics.example.tsv",
          reader_class: "io.anserini.search.topicreader.TsvStringTopicReader",
        },
      },
    ],
    ["https://example.test/tools/_metadata_qrels.json", { example: "qrels.example.txt" }],
    ["https://example.test/tools/_metadata_qrels_aliases.json", { example: ["example-test"] }],
  ]);
  const fetchImpl = async (input: string | URL) => {
    const value = responses.get(String(input));
    return value === undefined ? new Response("missing", { status: 404 }) : jsonResponse(value);
  };

  const catalog = await loadPrebuiltCatalog({
    fetchImpl,
    indexContentsUrl: "https://example.test/contents",
    anseriniToolsRawRoot: "https://example.test/tools",
  });

  assert.equal(findPrebuiltIndex(catalog, "example-index").corpus_index, "example-corpus");
  assert.equal(findAnseriniTopic(catalog, "example-test").path, "topics.example.tsv");
  assert.equal(findAnseriniQrels(catalog, "example-test").id, "example");
});

void test("prebuilt catalog reports unknown logical ids", () => {
  const empty = { indexes: [], topics: [], qrels: [] };
  assert.throws(() => findPrebuiltIndex(empty, "missing"), /Unknown prebuilt index/);
  assert.throws(() => findAnseriniTopic(empty, "missing"), /Unknown Anserini topics id/);
  assert.throws(() => findAnseriniQrels(empty, "missing"), /Unknown Anserini qrels id/);
});
