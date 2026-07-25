#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
QUERY_DIR="$ROOT/data/trec-rag-2026/queries"
QUERY_PATH="$QUERY_DIR/trec_rag_2026_queries.tsv"
SOURCE_REVISION="1de1b22ac7f9936be7e42c9e70d576cc9cb83770"
SOURCE_URL="https://raw.githubusercontent.com/TREC-RAG/trec-rag-data/$SOURCE_REVISION/trec-rag-2026/test-data/trec_rag_2026_queries.tsv"
EXPECTED_SHA256="72dc2fd358d3eeda973397ccd7a8775545b19a6deaefc67709167eee6a9f8a2c"

log() {
  printf '[setup:trec-rag-2026] %s\n' "$*"
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  printf 'Missing SHA-256 tool: install shasum or sha256sum.\n' >&2
  exit 1
}

main() {
  mkdir -p "$QUERY_DIR"
  local temp_path
  temp_path="$(mktemp "$QUERY_DIR/.trec_rag_2026_queries.tsv.XXXXXX")"
  trap 'rm -f "$temp_path"' EXIT

  log "Downloading official test narratives"
  curl --fail --location --silent --show-error "$SOURCE_URL" --output "$temp_path"

  local actual_sha256
  actual_sha256="$(sha256_file "$temp_path")"
  if [[ "$actual_sha256" != "$EXPECTED_SHA256" ]]; then
    printf 'Checksum mismatch for TREC RAG 2026 narratives.\nExpected: %s\nActual:   %s\n' \
      "$EXPECTED_SHA256" "$actual_sha256" >&2
    exit 1
  fi

  local row_count
  row_count="$(awk 'NF { count += 1 } END { print count + 0 }' "$temp_path")"
  if [[ "$row_count" != "119" ]]; then
    printf 'Expected 119 TREC RAG 2026 narratives, found %s.\n' "$row_count" >&2
    exit 1
  fi

  mv "$temp_path" "$QUERY_PATH"
  trap - EXIT
  log "Prepared $QUERY_PATH"
  log "Source revision: $SOURCE_REVISION"
  log "SHA-256: $actual_sha256"
}

main "$@"
