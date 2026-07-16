#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DATASET_ROOT="$ROOT/data/msmarco-v1-passage"
QUERY_DIR="$DATASET_ROOT/queries"
SOURCE_DL19="$DATASET_ROOT/source/topics.dl19-passage.tsv"
SOURCE_DL20="$DATASET_ROOT/source/topics.dl20.tsv"
SOURCE_DEV="$DATASET_ROOT/source/topics.dev-passage.tsv"
QRELS_DL19="$DATASET_ROOT/qrels/qrels.dl19-passage.txt"
QRELS_DL20="$DATASET_ROOT/qrels/qrels.dl20-passage.txt"
DL19_QUERIES="$QUERY_DIR/dl19.tsv"
DL20_QUERIES="$QUERY_DIR/dl20.tsv"
DL19_JUDGED_QUERIES="$QUERY_DIR/dl19-judged.tsv"
DL20_JUDGED_QUERIES="$QUERY_DIR/dl20-judged.tsv"
DEV_QUERIES="$QUERY_DIR/dev.tsv"

log() {
  printf '[setup:msmarco-v1-passage:query-slices] %s\n' "$*"
}

copy_query_set() {
  local source_path="$1"
  local target_path="$2"
  local label="$3"
  if [[ ! -f "$source_path" ]]; then
    printf 'Missing source query file for %s: %s\nRun setup first.\n' "$label" "$source_path" >&2
    exit 1
  fi
  cp "$source_path" "$target_path"
  log "Wrote $label query set to $target_path"
}

write_judged_query_set() {
  local source_path="$1"
  local qrels_path="$2"
  local target_path="$3"
  local label="$4"
  awk 'NR == FNR { judged[$1] = 1; next } $1 in judged' "$qrels_path" "$source_path" > "$target_path"
  log "Wrote $label judged query set to $target_path"
}

main() {
  mkdir -p "$QUERY_DIR"
  copy_query_set "$SOURCE_DL19" "$DL19_QUERIES" 'dl19'
  copy_query_set "$SOURCE_DL20" "$DL20_QUERIES" 'dl20'
  copy_query_set "$SOURCE_DEV" "$DEV_QUERIES" 'dev'
  write_judged_query_set "$SOURCE_DL19" "$QRELS_DL19" "$DL19_JUDGED_QUERIES" 'dl19'
  write_judged_query_set "$SOURCE_DL20" "$QRELS_DL20" "$DL20_JUDGED_QUERIES" 'dl20'
}

main "$@"
