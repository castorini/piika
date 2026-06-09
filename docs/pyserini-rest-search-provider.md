# Pyserini REST search provider

This document explains how to use the Pyserini REST backend with the `pi-search`
extension.

For the broader extension contract, see:

- `docs/pi-search-contract.md`
- `src/pi-search/README.md`

## What this provider does

The `pyserini-rest` backend lets `pi-search` talk to a running Pyserini REST
server instead of the in-repo Anserini BM25 helper.

It uses the Pyserini REST v1 endpoints:

- `GET /v1/{index}/search`
- `GET /v1/{index}/doc/{docid}`

Search results are normalized into the shared `PiSearchBackend` contract. The
agent can then use the same `search` and `read_document` tool names regardless
of backend.

## Extension config

Set `PI_SEARCH_EXTENSION_CONFIG` to a JSON object like this:

```json
{
  "backend": {
    "kind": "pyserini-rest",
    "baseUrl": "http://127.0.0.1:8081",
    "index": "browsecomp-plus",
    "searchMaxDocLength": 500
  }
}
```

Supported fields:

| Field                | Required | Meaning                                                                                             |
| -------------------- | -------: | --------------------------------------------------------------------------------------------------- |
| `kind`               |      yes | Must be `"pyserini-rest"`.                                                                          |
| `baseUrl`            |      yes | Base URL for the running Pyserini REST service.                                                     |
| `index`              |      yes | REST index name or path segment used under `/v1/{index}/...`.                                       |
| `tokenEnv`           |       no | Environment variable containing a bearer token for authenticated REST services.                     |
| `searchMaxDocLength` |       no | Passed to REST search as `max_doc_length`; defaults to `500`.                                       |
| `readMode`           |       no | `"full"` by default; `"paginated"` enables donor-compatible local line slicing for `read_document`. |

If `tokenEnv` is set and the named environment variable has a value, requests
include:

```text
Authorization: Bearer <token>
```

## Tool interface

Use the two-tool interface when running Pyserini REST experiments:

```bash
PI_SEARCH_TOOL_INTERFACE=pyserini-rest-2tool
```

In this mode, the extension registers:

- `search`
- `read_document`

It does not register `read_search_results`. The `search` tool returns visible
ranked hits directly instead of returning a `search_id`.

## Search behavior

The adapter calls:

```text
GET /v1/{index}/search?query=<query>&hits=<k>&max_doc_length=<n>
```

`searchMaxDocLength` controls `<n>`. If omitted, the adapter uses `500`.

The provider expects the REST response to include a `candidates` array. Each
candidate may include:

- `docid`
- `score`
- `rank`
- `doc`

`doc` may be either a string or an object. Object values are normalized by
preferring string fields named `text`, `contents`, `content`, or `body`.

The adapter also extracts `title` when `doc` is an object with a string `title`
field.

## Read-document behavior

The adapter always calls the REST get-document endpoint without
`max_doc_length`:

```text
GET /v1/{index}/doc/{docid}
```

This matches the REST API semantics: search may return truncated docs, while
get-document returns the full document.

### Default full-read mode

By default, or with `"readMode":"full"`, `read_document` takes only:

```json
{
  "reason": "verify the candidate document",
  "docid": "54513"
}
```

The adapter returns the full REST document. If a caller passes `offset` or
`limit` in full mode, the adapter rejects the request instead of pretending
REST supports paginated get-document.

### Donor-compatible paginated mode

For compatibility with the BrowseComp doc-reorg experiments, set:

```json
{
  "backend": {
    "kind": "pyserini-rest",
    "baseUrl": "http://127.0.0.1:8081",
    "index": "browsecomp-plus",
    "searchMaxDocLength": 500,
    "readMode": "paginated"
  }
}
```

With `PI_SEARCH_TOOL_INTERFACE=pyserini-rest-2tool`, this exposes
`read_document` with donor-style line pagination:

```json
{
  "reason": "inspect the references section",
  "docid": "54513",
  "offset": 1120,
  "limit": 220
}
```

The adapter still fetches the full document from REST. It then performs local
line slicing and returns continuation metadata such as `truncated` and
`nextOffset`.

This mode exists only to reproduce the older two-tool experiments. Prefer
`readMode:"full"` for the native Pyserini REST semantics.

## Example BrowseComp-Plus run

Start a Pyserini REST server separately, then run:

```bash
PI_SEARCH_EXTENSION_CONFIG='{"backend":{"kind":"pyserini-rest","baseUrl":"http://127.0.0.1:8081","index":"browsecomp-plus","searchMaxDocLength":500,"readMode":"paginated"}}' \
PI_SEARCH_TOOL_INTERFACE=pyserini-rest-2tool \
npx tsx src/orchestration/query_set.ts \
  --benchmark browsecomp-plus \
  --query-set q9 \
  --output-dir /tmp/pi-serini-current-q9-paginated \
  --model openai-codex/gpt-5.4-mini \
  --timeout-seconds 900
```

For native full-read behavior, omit `readMode` or set `"readMode":"full"`.

## Troubleshooting

If search fails with connection errors, verify the REST server is listening at
`baseUrl`.

If `read_document` rejects `offset` or `limit`, either remove those arguments or
set `"readMode":"paginated"` explicitly.

If search returns no text snippets, inspect the raw REST candidate shape. The
adapter can normalize common string/object document forms, but the REST response
must include a usable `doc` value for search previews.
