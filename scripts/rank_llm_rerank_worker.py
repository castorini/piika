"""Reranking worker for piika: rank_llm as a library, behind a minimal local HTTP endpoint.

piika's search tool runs in Node, and rank_llm is a Python package, so something
has to bridge the two. This is that bridge and nothing more: it builds rank_llm
coordinators (one per context mode, lazily), holds them for the process
lifetime, and answers rerank requests. All prompt construction, scoring and
permutation logic stays in rank_llm; the model is served by vLLM.

Deliberately stdlib-only (http.server, no FastAPI): the process sits on the
critical path of every search call an agent makes, so it should have as little
of its own machinery as possible. Every rank_llm setting is a flag (--help).

  pointwise yes/no relevance, matching the published Qwen3-Reranker computation
    python scripts/rank_llm_rerank_worker.py --port 8200 --kind pointwise \
        --model Qwen/Qwen3-Reranker-4B --vllm-url http://127.0.0.1:8000/v1 \
        --positive-token yes --negative-token no

  setwise selection over sliding windows (a generative listwise model)
    python scripts/rank_llm_rerank_worker.py --port 8201 --kind setwise \
        --model <model> --vllm-url http://127.0.0.1:8001/v1 \
        --template <prompt_template.yaml> --window-size 20 --stride 10

Then run piika with --rerank-worker-url http://127.0.0.1:8200 (docs/reranking.md).

Context modes (global_query, reasoning, full) need a rank_llm build whose
Query carries named context fields (Query.fields) and whose prompt templates
can render them; pass one template per mode (--template-<mode>). The no-context
mode works with the stock pointwise template.
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import threading
import time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from rank_llm.data import Candidate, Query, Request
from rank_llm.rerank import Reranker

logger = logging.getLogger("rerank_worker")

def context_mode_for(fields: dict) -> str:
    """Which context mode a request's fields correspond to.

    The reranker prompts state which context fields are present, and the model
    was trained on prompts where that claim is true. So the template has to be
    chosen per request from the fields actually supplied, not fixed at startup:
    an M3 template rendering an empty reasoning marker is a prompt shape the
    model never saw.
    """
    has_global = bool(str(fields.get("global_query") or "").strip())
    has_reasoning = bool(str(fields.get("reasoning") or "").strip())
    if has_global and has_reasoning:
        return "full"
    if has_global:
        return "global_query"
    if has_reasoning:
        return "reasoning"
    return "none"


def build_coordinator(args: argparse.Namespace, template: str | None):
    """A rank_llm coordinator for one template; cached per mode by the caller."""
    common = dict(
        base_url=args.vllm_url,
        context_size=args.context_size,
        batch_size=args.batch_size,
    )
    # rank_llm type-checks kwargs against its defaults, and the pointwise
    # default is a Path, so a plain string is rejected.
    kwargs = {"prompt_template_path": Path(template)} if template else {}
    if args.kind == "pointwise":
        # Answer tokens: the flags if given, else the template's output_tokens,
        # else rank_llm's yes/no defaults. The score is the probability of a
        # positive token over that of any answer token.
        answer = (
            {"positive_tokens": args.positive_token, "negative_tokens": args.negative_token}
            if args.positive_token
            else {}
        )
        return Reranker.create_model_coordinator(
            args.model, None, False,
            pointwise_vllm=True,
            max_passage_words=args.max_passage_words,
            **answer,
            **kwargs,
            **common,
        )
    return Reranker.create_model_coordinator(
        args.model, None, False,
        listwise_vllm_with_openai_sdk=True,
        window_size=args.window_size,
        stride=args.stride,
        max_passage_words=args.max_passage_words,
        is_thinking=args.thinking,
        sampling_kwargs={
            "temperature": args.temperature,
            "top_p": args.top_p,
            "top_k": args.top_k,
            "min_p": args.min_p,
        },
        **kwargs,
        **common,
    )


class RerankService:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.templates = dict(args.templates)
        # One reranker per context mode. Construction is cheap relative to a run
        # (a tokenizer and an HTTP client; the model lives in vLLM), and they are
        # built lazily so a run that never sees a trace never builds that mode.
        self.rerankers: dict[str, Reranker] = {}
        # rank_llm coordinators are not documented as thread-safe and the
        # listwise path keeps a semaphore bound to one event loop, so requests
        # are serialised here. Concurrency belongs in vLLM, which batches.
        self.lock = threading.Lock()

    def reranker_for(self, mode: str) -> Reranker:
        if mode not in self.rerankers:
            template = self.templates.get(mode)
            if template is None and mode != "none":
                raise ValueError(
                    f"No template configured for context mode {mode!r}. Pass "
                    f"--template-{mode.replace('_', '-')} or stop sending that field."
                )
            logger.info("building reranker for context mode %s (template=%s)", mode, template)
            self.rerankers[mode] = Reranker(build_coordinator(self.args, template))
        return self.rerankers[mode]

    def _cap_tokens(self, text, budget):
        if not budget or not text:
            return text
        if not hasattr(self, "_tok"):
            from transformers import AutoTokenizer
            self._tok = AutoTokenizer.from_pretrained(self.args.model)
        ids = self._tok.encode(str(text), add_special_tokens=False)
        return text if len(ids) <= budget else self._tok.decode(ids[:budget])

    def _log_request(self, payload, mode, query_text, fields, request, result, top_k) -> None:
        """One JSONL line per rerank request: what the model was asked, and what it said.

        rank_llm records one invocation per candidate in input order, so
        invocation i is first-stage candidate i. --log-prompts first keeps one
        candidate's messages (the others differ only in the document, which is
        the first-stage passage and recoverable by docid); all keeps every one.
        The rendered string is the served model's chat template applied the way
        vLLM applies it for these requests (enable_thinking=False).
        """
        invs = result.invocations_history or []
        scores = {str(c.docid): c.score for c in result.candidates}
        rec = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "qid": payload.get("qid"),
            "context_mode": mode,
            "template": self.templates.get(mode) or "stock pointwise_vllm_template.yaml",
            "query": query_text,
            "fields": fields,
            "depth": len(request.candidates),
            "top_k": top_k,
            "candidates": [
                {
                    "first_stage_rank": i + 1,
                    "docid": str(c.docid),
                    "first_stage_score": c.score,
                    "passage_chars": len(c.doc.get("contents") or ""),
                    "prompt_tokens": invs[i].input_token_count if i < len(invs) else None,
                    "score": scores.get(str(c.docid)),
                }
                for i, c in enumerate(request.candidates)
            ],
            "returned": [str(c.docid) for c in result.candidates[:top_k]],
        }
        if invs and self.args.log_prompts in ("first", "all"):
            if not hasattr(self, "_tok"):
                from transformers import AutoTokenizer
                self._tok = AutoTokenizer.from_pretrained(self.args.model)
            first = invs[0].prompt
            rec["prompt_example"] = {
                "first_stage_rank": 1,
                "messages": first,
                "rendered": self._tok.apply_chat_template(
                    first, add_generation_prompt=True, tokenize=False, enable_thinking=False
                ),
            }
            if self.args.log_prompts == "all":
                rec["prompts"] = [inv.prompt for inv in invs]
        with open(self.args.log_requests, "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    # Setwise only. Both paths build a passage with rank_llm's _convert_doc_to_prompt_content, but the
    # listwise path silently lowers the word cap for a whole window when the prompt exceeds --context-size,
    # so a selector may see shorter passages than a pointwise reranker given the same candidates. Every
    # window's passages are compared with the uncut ones, and any cut is counted, logged and returned, as
    # are window outputs that are not a valid selection.
    _NUM_RE = re.compile(r"provide you with (\d+) (?:documents|passages)")
    _BODY_RE = re.compile(r"^\[(\d+)\] (.*)$", re.M)
    _VALID_RE = re.compile(r"\s*\[\d+\](?:\s*\[\d+\])*\s*")

    def _setwise_check(self, mode: str, request, result) -> dict:
        handler = self.reranker_for(mode)._model_coordinator._inference_handler
        expected = {
            handler._convert_doc_to_prompt_content(c.doc, self.args.max_passage_words) for c in request.candidates
        }
        windows, cut, invalid = [], 0, 0
        for inv in result.invocations_history or []:
            msgs = inv.prompt if isinstance(inv.prompt, list) else [{"role": "user", "content": str(inv.prompt)}]
            user = [m["content"] for m in msgs if m.get("role") == "user"][-1]
            m = self._NUM_RE.search(user)
            num = int(m.group(1)) if m else 0
            bodies = self._BODY_RE.findall(user)[-num:] if num else []
            bad = [p for _, p in bodies if p not in expected]
            ids = [int(x) for x in re.findall(r"\[(\d+)\]", inv.response or "")]
            valid = bool(self._VALID_RE.fullmatch(inv.response or "")) and all(1 <= i <= num for i in ids) \
                and len(ids) == len(set(ids))
            cut += len(bad) + (num - len(bodies))
            invalid += not valid
            windows.append({
                "num": num, "passages_found": len(bodies), "passages_cut": len(bad) + (num - len(bodies)),
                "cut_examples": [{"chars": len(p), "head": p[:80]} for p in bad[:3]],
                "prompt_tokens": inv.input_token_count, "completion_tokens": inv.output_token_count,
                "response": inv.response, "valid": valid,
            })
        if cut:
            logger.warning("PASSAGES_CUT qid=%s: %d passage(s) differ from the uncut text", request.query.qid, cut)
        return {"windows": windows, "passages_cut": cut, "invalid_outputs": invalid}

    def _log_setwise(self, payload, mode, query_text, fields, request, result, top_k, check) -> None:
        """One JSONL line per rerank request for the setwise path: one entry per window (rank_llm records one
        invocation per window), the passage check, and the window prompts (first window or all)."""
        rec = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "qid": payload.get("qid"),
            "context_mode": mode,
            "template": self.templates.get(mode),
            "query": query_text,
            "fields": fields,
            "depth": len(request.candidates),
            "top_k": top_k,
            "candidates": [
                {"first_stage_rank": i + 1, "docid": str(c.docid), "first_stage_score": c.score,
                 "passage_chars": len(c.doc.get("contents") or ""),
                 **({"text": c.doc.get("contents") or ""} if self.args.log_candidate_text else {})}
                for i, c in enumerate(request.candidates)
            ],
            "windows": check["windows"],
            "passages_cut": check["passages_cut"],
            "invalid_outputs": check["invalid_outputs"],
            "final_order": [str(c.docid) for c in result.candidates],
            "returned": [str(c.docid) for c in result.candidates[:top_k]],
        }
        invs = result.invocations_history or []
        if invs and self.args.log_prompts == "first":
            rec["prompt_example"] = invs[0].prompt
        elif self.args.log_prompts == "all":
            rec["prompts"] = [inv.prompt for inv in invs]
        with open(self.args.log_requests, "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def rerank(self, payload: dict) -> dict:
        query_text = payload["query"]
        fields = payload.get("query_fields") or {}
        candidates = payload["candidates"]
        top_k = int(payload.get("top_k") or len(candidates))
        depth = min(int(payload.get("depth") or len(candidates)), len(candidates))

        # The mode is decided on the canonical field names the harness sends;
        # the rename only matters to the template (e.g. a template that calls
        # the trace `query_intent`).
        mode = context_mode_for(fields)
        fields = {self.args.field_map.get(k, k): v for k, v in fields.items()}
        # Per-field token budgets (head kept), e.g. the caps a context-aware
        # reranker was trained with. Applied after the rename so budgets are
        # keyed by the template's field names.
        if self.args.field_max_tokens:
            fields = {k: self._cap_tokens(v, self.args.field_max_tokens.get(k)) for k, v in fields.items()}
            query_text = self._cap_tokens(query_text, self.args.field_max_tokens.get("query"))
        request = Request(
            query=Query(text=query_text, qid=str(payload.get("qid") or "0"), fields=fields),
            candidates=[
                Candidate(
                    docid=str(c["docid"]),
                    score=float(c.get("score") or 0.0),
                    doc={"contents": self._cap_tokens(c.get("text") or "", self.args.max_passage_tokens)},
                )
                for c in candidates[:depth]
            ],
        )

        with self.lock:
            results = self.reranker_for(mode).rerank_batch(
                [request],
                rank_start=0,
                rank_end=depth,
                populate_invocations_history=True,
            )
            check = None
            if self.args.kind == "setwise":
                check = self._setwise_check(mode, request, results[0])
                if self.args.log_requests:
                    self._log_setwise(payload, mode, query_text, fields, request, results[0], top_k, check)
            elif self.args.log_requests:
                self._log_request(payload, mode, query_text, fields, request, results[0], top_k)

        result = results[0]
        # rank_llm swallows per-call inference errors (it logs, then returns
        # an empty usage and a -1.0 score) so a batch always completes. Here a
        # failed call must fail the request instead: the harness retries, then
        # aborts the query as rerank_error, rather than recording a "rerank"
        # that never happened.
        invocations = result.invocations_history or []
        failed = [
            inv for inv in invocations
            if (inv.token_usage is not None and not inv.token_usage)
            or (inv.token_usage is None and not inv.output_token_count)
        ]
        if failed:
            raise RuntimeError(
                f"{len(failed)}/{len(invocations)} reranker calls failed: "
                f"{str(failed[0].response)[:200]}"
            )
        if self.args.kind == "pointwise" and result.candidates and all(
            c.score == -1.0 for c in result.candidates
        ):
            raise RuntimeError("every candidate scored -1.0 (inference failure sentinel)")
        prompt_tokens = completion_tokens = 0
        for inv in (result.invocations_history or []):
            prompt_tokens += getattr(inv, "input_token_count", 0) or 0
            completion_tokens += getattr(inv, "output_token_count", 0) or 0

        extra = {} if check is None else {"passage_check": {
            "windows": len(check["windows"]), "passages_cut": check["passages_cut"],
            "invalid_outputs": check["invalid_outputs"]}}
        return {
            **extra,
            "docids": [str(c.docid) for c in result.candidates[:top_k]],
            "scores": [
                float(c.score) if c.score is not None else 0.0
                for c in result.candidates[:top_k]
            ],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "calls": len(result.invocations_history or []),
            },
            "depth": depth,
            "context_mode": mode,
            "context_fields": sorted(k for k, v in fields.items() if str(v).strip()),
        }


def make_handler(service: RerankService):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, status: int, body: dict) -> None:
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:  # noqa: N802
            if self.path.rstrip("/") == "/healthz":
                self._send(200, {"status": "ok", "kind": service.args.kind,
                                 "model": service.args.model})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path.rstrip("/") != "/rerank":
                self._send(404, {"error": "not found"})
                return
            length = int(self.headers.get("content-length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
                self._send(200, service.rerank(payload))
            except Exception as error:  # noqa: BLE001
                logger.exception("rerank failed")
                # The caller retries, then aborts the query as rerank_error; a
                # search never continues on first-stage order.
                self._send(500, {"error": f"{type(error).__name__}: {error}"})

        def log_message(self, fmt: str, *fmt_args) -> None:  # quieter default log
            logger.debug(fmt, *fmt_args)

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--kind", choices=["pointwise", "setwise"], required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--vllm-url", required=True)
    # One template per context mode; the mode is chosen per request.
    ap.add_argument("--template", default=None, help="template for the no-context mode")
    ap.add_argument("--template-reasoning", default=None)
    ap.add_argument("--template-global-query", default=None)
    ap.add_argument("--template-full", default=None)
    ap.add_argument(
        "--field-map", action="append", default=[], metavar="SRC=DST",
        help="rename a context field for the template, e.g. reasoning=query_intent",
    )
    ap.add_argument(
        "--field-max-tokens", action="append", default=[], metavar="FIELD=N",
        help="cap a query field at N tokens (head kept); 'query' caps the sub-query",
    )
    ap.add_argument("--context-size", type=int, default=8192)
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--max-passage-words", type=int, default=300)
    ap.add_argument("--max-passage-tokens", type=int, default=None, help="cap each candidate at N tokens of the served model's tokenizer (head kept); overrides the word cap")
    ap.add_argument("--log-requests", default=None, help="append one JSONL line per rerank request to this file")
    ap.add_argument("--log-prompts", choices=["none", "first", "all"], default="first",
                    help="with --log-requests: prompt messages logged per request")
    ap.add_argument("--log-candidate-text", action="store_true",
                    help="setwise, with --log-requests: also log every candidate's text as received (smoke checks)")
    ap.add_argument("--window-size", type=int, default=20, help="setwise: candidates per window")
    ap.add_argument("--stride", type=int, default=10, help="setwise: window step")
    ap.add_argument("--positive-token", action="append", default=[], metavar="TOKEN",
                    help="pointwise: a token that answers 'relevant', e.g. yes or true (repeatable; "
                         "with --negative-token). Unset: the template's output_tokens, else rank_llm's yes/no")
    ap.add_argument("--negative-token", action="append", default=[], metavar="TOKEN",
                    help="pointwise: a token that answers 'not relevant', e.g. no or false (repeatable)")
    ap.add_argument("--thinking", action="store_true", help="setwise: let the model think before selecting")
    ap.add_argument("--temperature", type=float, default=0.7, help="setwise sampling")
    ap.add_argument("--top-p", type=float, default=0.8, help="setwise sampling")
    ap.add_argument("--top-k", type=int, default=20, help="setwise sampling")
    ap.add_argument("--min-p", type=float, default=0.0, help="setwise sampling")
    args = ap.parse_args()
    if bool(args.positive_token) != bool(args.negative_token):
        ap.error("--positive-token and --negative-token must be given together")

    args.field_map = dict(kv.split("=", 1) for kv in args.field_map)
    args.field_max_tokens = {k: int(v) for k, v in (kv.split("=", 1) for kv in args.field_max_tokens)}
    if args.max_passage_tokens:
        args.max_passage_words = 100000  # the token cap decides
    args.templates = {
        "none": args.template,
        "reasoning": args.template_reasoning,
        "global_query": args.template_global_query,
        "full": args.template_full,
    }
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    # Provenance: the complete effective configuration, and the rank_llm build.
    import rank_llm
    logger.info("config %s", json.dumps({k: v for k, v in vars(args).items()}, default=str, sort_keys=True))
    logger.info("rank_llm from %s", rank_llm.__file__)
    service = RerankService(args)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(service))
    logger.info("rerank worker ready kind=%s model=%s on %s:%d",
                args.kind, args.model, args.host, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
