import type { BenchmarkDefinition } from "./types";

export const trecRag2026Benchmark: BenchmarkDefinition = {
  id: "trec-rag-2026",
  aliases: ["trec_rag_2026", "rag2026", "trec-rag26"],
  displayName: "TREC RAG 2026",
  datasetId: "trec-rag-2026",
  piSearchPromptVariant: "trec_rag",
  defaultQuerySetId: "test",
  defaultQueryPath: "data/trec-rag-2026/queries/trec_rag_2026_queries.tsv",
  querySets: {
    test: "data/trec-rag-2026/queries/trec_rag_2026_queries.tsv",
  },
  defaultIndexPath: "climbmix-400b",
  managedPresets: {},
  setup: {
    steps: {
      setup: "scripts/benchmarks/trec_rag_2026/setup.sh",
    },
  },
  retrievalEvaluation: {
    runFileBackend: "none",
    runDirBackend: "none",
  },
  source: {
    kind: "github-file",
    repository: "TREC-RAG/trec-rag-data",
    revision: "1de1b22ac7f9936be7e42c9e70d576cc9cb83770",
    path: "trec-rag-2026/test-data/trec_rag_2026_queries.tsv",
    url: "https://raw.githubusercontent.com/TREC-RAG/trec-rag-data/1de1b22ac7f9936be7e42c9e70d576cc9cb83770/trec-rag-2026/test-data/trec_rag_2026_queries.tsv",
    sha256: "72dc2fd358d3eeda973397ccd7a8775545b19a6deaefc67709167eee6a9f8a2c",
  },
};
