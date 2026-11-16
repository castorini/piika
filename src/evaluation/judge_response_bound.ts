/**
 * Opt-in bound on the answer handed to the judge: PIIKA_JUDGE_MAX_RESPONSE_CHARS=<n>.
 *
 * A degenerate generation can end in a 100K+ character answer, and the judge
 * prompt is passed to pi on the command line; head + tail keeps the "Exact
 * Answer" block, which agents put last. NUL bytes (which make the judge spawn
 * throw ERR_INVALID_ARG_VALUE) are dropped too. Unset = the answer is passed
 * unchanged.
 */
export function resolveJudgeMaxResponseChars(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.PIIKA_JUDGE_MAX_RESPONSE_CHARS?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 2) {
    throw new Error(`PIIKA_JUDGE_MAX_RESPONSE_CHARS must be an integer >= 2; received ${raw}`);
  }
  return value;
}

export function boundJudgedResponse(text: string, maxChars: number): string {
  const clean = text.replaceAll("\u0000", "");
  if (clean.length <= maxChars) return clean;
  const head = Math.ceil(maxChars / 2);
  const tail = maxChars - head;
  return `${clean.slice(0, head)}\n\n[... ${clean.length - maxChars} characters omitted ...]\n\n${clean.slice(clean.length - tail)}`;
}
