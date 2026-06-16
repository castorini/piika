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

## 3. Smoke-check npm package contents

Confirm the npm tarball contains the CLI wrapper, TypeScript sources, setup scripts, docs, and JVM BM25 server source:

```bash
npm pack --dry-run
```

Confirm the dry-run output includes at least:

- `bin/piika.js`
- `src/orchestration/query_set.ts`
- `scripts/benchmarks/browsecomp_plus/setup.sh`
- `jvm/src/main/java/dev/jhy/piserini/Bm25Server.java`
- `docs/cli.md`

For a local install smoke test:

```bash
npm pack --pack-destination /tmp
npm uninstall -g piika
npm install -g /tmp/piika-<version>.tgz
piika --help
piika benchmarks
piika setup benchmark-template --dry-run
piika run --benchmark benchmark-template --query-set test --dry-run
```

## 4. Smoke-check core release workflows

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

## 5. Verify npm Trusted Publisher setup

Before publishing a GitHub release that should publish to npm, confirm npmjs.com has a Trusted Publisher configured for the package:

- Provider: GitHub Actions
- Organization/user: `castorini`
- Repository: `piika`
- Workflow filename: `publish-npm.yml`
- Allowed action: `npm publish`

The workflow path in this repo is `.github/workflows/publish-npm.yml`.

## 6. Final review before tagging

- Re-read `CHANGELOG.md` entry for the release.
- Re-read `docs/releases/<version>.md` for external-facing wording.
- Confirm benchmark names are spelled consistently:
  - `BrowseComp-Plus`
  - `MS MARCO v1 Passage`
- Confirm the release is described as index-driven if document-ingestion-first support is not included yet.

## 7. Commit and tag

Example:

```bash
git add CHANGELOG.md README.md docs/releases/v0.1.0.md RELEASE_CHECKLIST.md
git commit -m "release: prepare v0.1.0"
git tag -a v0.1.0 -m "v0.1.0"
```

## 8. Publish GitHub release and npm package

- Create a GitHub release for tag `v0.1.0`.
- Use `docs/releases/v0.1.0.md` as the release body.
- Verify links and code blocks render correctly in GitHub's release UI.
- Publishing the GitHub release triggers `.github/workflows/publish-npm.yml`.
- Confirm the `Publish npm package` workflow succeeds.
- Confirm the expected version appears on npm.

## 9. Post-release follow-up

- Announce the release.
- Open or prioritize the next milestone items for:
  - document-ingestion-first indexing via Anserini `IndexCollection`
  - broader benchmark coverage
  - continued cleanup of duplicated CLI parsing across entrypoints
