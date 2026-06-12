# Release Checklist

This checklist is for cutting a `piika` release tag and publishing the matching GitHub release notes.

## 1. Finalize release scope

- Confirm the target version number.
- Confirm `CHANGELOG.md` contains a finalized entry for that version.
- Confirm `README.md` matches the intended release positioning.
- Confirm release notes exist under `docs/releases/` for the target version.
- Confirm the release does not claim features that are not merged yet.

## 2. Verify repo state

- Confirm the working tree is clean except for intentional release-prep files.
- Review the full diff, not just the most recent edits.
- Confirm no local-only assets under `data/`, `indexes/`, `runs/`, `evals/`, `vendor/`, `notes/`, or `scratch/` are staged accidentally.

Suggested commands:

```bash
git status
npm run check
npx tsx --test tests/*.test.ts tests/**/*.test.ts
```

## 3. Smoke-check core release workflows

Run the smallest checks that validate the release narrative.

### Benchmark catalog

```bash
npm run bench -- benchmarks
```

Confirm the catalog includes:

- `browsecomp-plus`
- `msmarco-v1-passage`
- `benchmark-template`

### Setup smoke checks

If local environment and network access are available, validate benchmark setup entrypoints:

```bash
npm run setup:benchmark -- --benchmark benchmark-template --dry-run
npm run setup:benchmark -- --benchmark msmarco-v1-passage --step query-slices --dry-run
```

### Launch smoke checks

Validate benchmark launch planning without running a full benchmark:

```bash
BENCHMARK=msmarco-v1-passage QUERY_SET=dl19 PI_SERINI_DRY_RUN=1 npm run run:benchmark:query-set
BENCHMARK=browsecomp-plus QUERY_SET=q9 PI_SERINI_DRY_RUN=1 npm run run:benchmark:query-set:shared-bm25
```

### Evaluation wrapper smoke checks

Use `--help` or dry-run-friendly entrypoints to confirm wrappers still resolve:

```bash
npx tsx src/wrappers/evaluate_retrieval_entry.ts --help
npx tsx src/wrappers/evaluate_run_with_pi_entry.ts --help
npx tsx src/wrappers/report_run_markdown_entry.ts --help
```

## 4. Final review before tagging

- Re-read `CHANGELOG.md` entry for the release.
- Re-read `docs/releases/<version>.md` for external-facing wording.
- Confirm benchmark names are spelled consistently:
  - `BrowseComp-Plus`
  - `MS MARCO v1 Passage`
- Confirm the release is described as index-driven if document-ingestion-first support is not included yet.

## 5. Commit and tag

Example:

```bash
git add CHANGELOG.md README.md docs/releases/v0.1.0.md RELEASE_CHECKLIST.md
git commit -m "release: prepare v0.1.0"
git tag -a v0.1.0 -m "v0.1.0"
```

## 6. Publish release notes

- Create a GitHub release for tag `v0.1.0`.
- Use `docs/releases/v0.1.0.md` as the release body.
- Verify links and code blocks render correctly in GitHub's release UI.

## 7. Post-release follow-up

- Announce the release.
- Open or prioritize the next milestone items for:
  - document-ingestion-first indexing via Anserini `IndexCollection`
  - broader benchmark coverage
  - continued cleanup of duplicated CLI parsing across entrypoints
