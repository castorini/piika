#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DATASET_ROOT="$ROOT/data/msmarco-v1-passage"
SOURCE_DIR="$DATASET_ROOT/source"
QUERY_DIR="$DATASET_ROOT/queries"
QRELS_DIR="$DATASET_ROOT/qrels"
DOWNLOAD_DIR="$ROOT/vendor/downloads"
ANSERINI_DIR="$ROOT/vendor/anserini"
INDEX_NAME="${INDEX_NAME:-msmarco-v1-passage}"
INDEX_DIR="$ROOT/indexes/$INDEX_NAME"
INDEX_ARCHIVE="$DOWNLOAD_DIR/lucene-inverted.msmarco-v1-passage.20221004.252b5e.tar.gz"
INDEX_URL="${MSMARCO_V1_PASSAGE_INDEX_URL:-https://huggingface.co/datasets/castorini/prebuilt-indexes-msmarco-v1/resolve/main/passage/original/lucene-inverted/tf/lucene-inverted.msmarco-v1-passage.20221004.252b5e.tar.gz}"
ANSERINI_FATJAR_URL="${ANSERINI_FATJAR_URL:-https://repo1.maven.org/maven2/io/anserini/anserini/1.6.0/anserini-1.6.0-fatjar.jar}"
ANSERINI_JAR="$ANSERINI_DIR/anserini-1.6.0-fatjar.jar"
ANSERINI_THREADS="${ANSERINI_THREADS:-1}"
DL19_TOPICS_URL="${MSMARCO_V1_PASSAGE_DL19_TOPICS_URL:-https://raw.githubusercontent.com/castorini/anserini-tools/303096fd01ab1ee5048adc6b4a25d55761e6c860/topics-and-qrels/topics.dl19-passage.txt}"
DL19_QRELS_URL="${MSMARCO_V1_PASSAGE_DL19_QRELS_URL:-https://raw.githubusercontent.com/castorini/anserini-tools/303096fd01ab1ee5048adc6b4a25d55761e6c860/topics-and-qrels/qrels.dl19-passage.txt}"
DL20_TOPICS_URL="${MSMARCO_V1_PASSAGE_DL20_TOPICS_URL:-https://raw.githubusercontent.com/castorini/anserini-tools/303096fd01ab1ee5048adc6b4a25d55761e6c860/topics-and-qrels/topics.dl20.txt}"
DL20_QRELS_URL="${MSMARCO_V1_PASSAGE_DL20_QRELS_URL:-https://raw.githubusercontent.com/castorini/anserini-tools/303096fd01ab1ee5048adc6b4a25d55761e6c860/topics-and-qrels/qrels.dl20-passage.txt}"
DEV_TOPICS_URL="${MSMARCO_V1_PASSAGE_DEV_TOPICS_URL:-https://raw.githubusercontent.com/castorini/anserini-tools/12982126736f2ed7dc45bf30acb2af9fed13c0ef/topics-and-qrels/topics.msmarco-passage.dev-subset.txt}"
DEV_QRELS_URL="${MSMARCO_V1_PASSAGE_DEV_QRELS_URL:-https://raw.githubusercontent.com/castorini/anserini-tools/12982126736f2ed7dc45bf30acb2af9fed13c0ef/topics-and-qrels/qrels.msmarco-passage.dev-subset.txt}"
DL19_SOURCE_QUERIES="$SOURCE_DIR/topics.dl19-passage.tsv"
DL20_SOURCE_QUERIES="$SOURCE_DIR/topics.dl20.tsv"
DEV_SOURCE_QUERIES="$SOURCE_DIR/topics.dev-passage.tsv"
DL19_QRELS_FILE="$QRELS_DIR/qrels.dl19-passage.txt"
DL20_QRELS_FILE="$QRELS_DIR/qrels.dl20-passage.txt"
DEV_QRELS_FILE="$QRELS_DIR/qrels.dev-passage.txt"
DL19_BASELINE_RUN="$SOURCE_DIR/bm25_pure.dl19.trec"
DL20_BASELINE_RUN="$SOURCE_DIR/bm25_pure.dl20.trec"
DEV_BASELINE_RUN="$SOURCE_DIR/bm25_pure.dev.trec"

log() {
  printf '[setup:msmarco-v1-passage] %s\n' "$*"
}

ensure_command() {
  local command_name="$1"
  local hint="$2"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n%s\n' "$command_name" "$hint" >&2
    exit 1
  fi
}

fetch_file() {
  local url="$1"
  local output_path="$2"
  mkdir -p "$(dirname "$output_path")"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --silent --show-error --continue-at - "$url" --output "$output_path"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -c -O "$output_path" "$url"
    return
  fi
  printf 'Missing required downloader. Install curl or wget.\n' >&2
  exit 1
}

extract_index_archive() {
  local archive_path="$1"
  local destination_dir="$2"
  local temp_dir
  temp_dir="$(mktemp -d "$ROOT/indexes/.msmarco_extract.XXXXXX")"

  rm -rf "$destination_dir"
  mkdir -p "$destination_dir"

  tar -xzf "$archive_path" -C "$temp_dir"

  shopt -s nullglob dotglob
  local children=("$temp_dir"/*)
  shopt -u nullglob dotglob

  if [[ ${#children[@]} -eq 1 && -d "${children[0]}" ]]; then
    shopt -s nullglob dotglob
    local nested=("${children[0]}"/*)
    shopt -u nullglob dotglob
    if [[ ${#nested[@]} -eq 0 ]]; then
      rm -rf "$temp_dir"
      printf 'Extracted index archive is empty: %s\n' "$archive_path" >&2
      exit 1
    fi
    mv "${nested[@]}" "$destination_dir/"
  else
    if [[ ${#children[@]} -eq 0 ]]; then
      rm -rf "$temp_dir"
      printf 'Extracted index archive is empty: %s\n' "$archive_path" >&2
      exit 1
    fi
    mv "${children[@]}" "$destination_dir/"
  fi

  rm -rf "$temp_dir"
}

write_baseline_run() {
  local query_path="$1"
  local output_path="$2"
  local label="$3"
  log "Generating baseline BM25 run for $label at $output_path"
  java -cp "$ANSERINI_JAR" \
    io.anserini.search.SearchCollection \
    -topicReader TsvString \
    -topics "$query_path" \
    -index "$INDEX_DIR" \
    -output "$output_path" \
    -bm25 \
    -hits 1000 \
    -threads "$ANSERINI_THREADS"
}

main() {
  cd "$ROOT"
  ensure_command java 'Install Java 21 or newer so Anserini can generate the MSMARCO baseline runs.'
  ensure_command tar 'Install tar so the prebuilt MSMARCO index archive can be extracted.'

  mkdir -p "$SOURCE_DIR" "$QUERY_DIR" "$QRELS_DIR" "$DOWNLOAD_DIR" "$ANSERINI_DIR" "$ROOT/indexes"

  if [[ ! -f "$ANSERINI_JAR" ]]; then
    log "Downloading Anserini fatjar from $ANSERINI_FATJAR_URL"
    fetch_file "$ANSERINI_FATJAR_URL" "$ANSERINI_JAR"
  else
    log "Reusing existing Anserini fatjar at $ANSERINI_JAR"
  fi

  log "Downloading MSMARCO dl19 topics from $DL19_TOPICS_URL"
  fetch_file "$DL19_TOPICS_URL" "$DL19_SOURCE_QUERIES"
  log "Downloading MSMARCO dl19 qrels from $DL19_QRELS_URL"
  fetch_file "$DL19_QRELS_URL" "$DL19_QRELS_FILE"

  log "Downloading MSMARCO dl20 topics from $DL20_TOPICS_URL"
  fetch_file "$DL20_TOPICS_URL" "$DL20_SOURCE_QUERIES"
  log "Downloading MSMARCO dl20 qrels from $DL20_QRELS_URL"
  fetch_file "$DL20_QRELS_URL" "$DL20_QRELS_FILE"

  log "Downloading MSMARCO dev topics from $DEV_TOPICS_URL"
  fetch_file "$DEV_TOPICS_URL" "$DEV_SOURCE_QUERIES"
  log "Downloading MSMARCO dev qrels from $DEV_QRELS_URL"
  fetch_file "$DEV_QRELS_URL" "$DEV_QRELS_FILE"

  log 'Materializing benchmark query sets'
  bash scripts/benchmarks/msmarco_v1_passage/generate_query_slices.sh

  if [[ ! -f "$INDEX_ARCHIVE" ]]; then
    log "Downloading MSMARCO prebuilt index archive from $INDEX_URL"
    fetch_file "$INDEX_URL" "$INDEX_ARCHIVE"
  else
    log "Reusing downloaded MSMARCO prebuilt index archive at $INDEX_ARCHIVE"
  fi

  log "Extracting MSMARCO prebuilt index into $INDEX_DIR"
  extract_index_archive "$INDEX_ARCHIVE" "$INDEX_DIR"
  rm -f "$INDEX_DIR/write.lock"

  write_baseline_run "$DL19_SOURCE_QUERIES" "$DL19_BASELINE_RUN" 'dl19'
  write_baseline_run "$DL20_SOURCE_QUERIES" "$DL20_BASELINE_RUN" 'dl20'
  write_baseline_run "$DEV_SOURCE_QUERIES" "$DEV_BASELINE_RUN" 'dev'

  log 'Setup complete.'
  log 'Prepared local outputs:'
  log "- $DL19_SOURCE_QUERIES"
  log "- $DL20_SOURCE_QUERIES"
  log "- $DEV_SOURCE_QUERIES"
  log "- $DL19_QRELS_FILE"
  log "- $DL20_QRELS_FILE"
  log "- $DEV_QRELS_FILE"
  log "- $DATASET_ROOT/queries/dl19.tsv"
  log "- $DATASET_ROOT/queries/dl20.tsv"
  log "- $DATASET_ROOT/queries/dl19-judged.tsv"
  log "- $DATASET_ROOT/queries/dl20-judged.tsv"
  log "- $DATASET_ROOT/queries/dev.tsv"
  log "- $DL19_BASELINE_RUN"
  log "- $DL20_BASELINE_RUN"
  log "- $DEV_BASELINE_RUN"
  log "- $INDEX_DIR"
  log "- $INDEX_ARCHIVE"
  log "- $ANSERINI_JAR"
  log 'Judge evaluation is intentionally not configured by default for this benchmark.'
}

main "$@"
