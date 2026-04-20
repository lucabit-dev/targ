# Example: contradiction_split_service_failure

Rendered **canonical Markdown** packet for the golden case
[`contradiction_split_service_failure.json`](../../evals/golden/cases/contradiction_split_service_failure.json).

This example stress-tests the spec on a **low-confidence, contradiction-bearing case**,
without Phase 5 repo context. It validates three rules from the spec:

- §2.3 "Best guess always" — even at `low` confidence, the packet commits to a headline.
- §2.2 "Calibrated, not coded" — TARG's `UNCLEAR` + `REQUEST_INPUT` are translated into
  plain English without leaking enum names.
- §9 invariants — every evidence item referenced by a hypothesis exists in the packet,
  and `nextStep.mode` is `collect_evidence` (not `implement`) because
  `policy.mayCommit === false`.

---

```markdown
# API and worker evidence disagree on the failing boundary

Checkout failures look split across the API and worker layers.

_Case: [c_contra01](https://targ.app/cases/c_contra01) · generated 2026-04-20T14:45:02Z_

## Best current read

Two independent failure signals are surfacing — one in the API request path
(`submitCheckout`) and one in the worker loop (`runWorker`) — and the current evidence
does not show which one is causing the other.

**Confidence:** low. The API log and the worker log describe failures at different
frames with no shared request identifier to tie them together.

**Affected area:** checkout flow across the API and worker layers

## Evidence

1. **api-log** (log, paste)
   A GET /api/checkout request produced a 500 at `submitCheckout` line 44, with request
   id `req-600`.
   ```
   2026-04-09T00:00:00Z service=api requestId=req-600 GET /api/checkout
   Error: failed
       at submitCheckout (/srv/checkout.js:44:9)
   ```

2. **worker-log** (terminal, paste)
   A worker retry loop failed at `runWorker` line 12. No timestamp or request id is
   attached, so it is not clear whether it corresponds to the same request above.
   ```
   service=worker
   retry loop failed
       at runWorker (/srv/worker.js:12:2)
   ```

## Hypotheses

1. **The worker retry loop is the cause; the API 500 is a downstream symptom** —
   confidence: medium
   If the worker is failing to process a payment-related job, `submitCheckout` could
   fall through to a 500 when it reads an empty or errored worker result.
   Supports: #2
   Weakened by: #1 (no request id in the worker log to confirm the link)

2. **The API failure is the cause; the worker failure is unrelated** — confidence: low
   `submitCheckout` throws before the worker is ever invoked for this request, and the
   worker log is from a separate job. The two logs are co-occurring by chance.
   Supports: #1
   Weakened by: #2

3. **Both are symptoms of a shared dependency failure (upstream provider or config)** —
   confidence: low
   Neither log contains env hints, provider names, or config values, so a common
   dependency outage cannot be ruled out without more signal.

## Open questions

- Can the worker log be re-captured with a request id or a timestamp aligned to
  `req-600`, so the two failures can be tied together or separated?
- Was there a deploy, config change, or provider incident in the last 24 hours that
  touched both the API and the worker?
- Does `submitCheckout` synchronously invoke the worker, or does it return a response
  independent of worker status?

## Next step

**collect_evidence:** Add one piece of evidence that either ties the two failures
together or clearly separates them: either a worker log entry containing `req-600`, or
a `submitCheckout` trace showing whether it depends on the worker path.

**Done when:**
- The packet contains evidence that makes one of the three hypotheses above clearly
  more likely than the others.
- A follow-up diagnosis reaches `medium` confidence or higher.
```

---

## What this example demonstrates

1. **Low confidence still commits.** The `Best current read` paragraph names a concrete
   read ("two independent failure signals, one in API and one in worker") even though
   neither hypothesis is above `medium`. No "cannot determine" cop-out.
2. **Contradictions are not a separate section.** Per §12, contradictions are expressed
   through `confidenceNote` + per-hypothesis `weakenedByEvidenceIds`. No `##
   Contradictions` header.
3. **Open questions are specific and answerable.** Per §2.1 and §3.4 of the roadmap,
   these are not generic "add more logs" — each question, if answered, shifts the
   diagnosis.
4. **Next step is `collect_evidence`, not `investigate`.** The case has two evidence
   items but they conflict; the productive move is to disambiguate, not to poke
   around. The acceptance criteria make "done" measurable.
5. **No TARG vocabulary leaks.** No `UNCLEAR`, no `REQUEST_INPUT`, no `DOCTRINE`, no
   `claimKey` / UUIDs in the rendered output.
6. **No repo context or priors sections.** They are correctly omitted because
   `repoContext` and `priors` are unset at this phase. Per §6.1, empty optional
   sections are never rendered with empty bodies.

## Why this is useful as a test fixture

Before Phase 1.1 code exists, this file is the **expected output** for a specific
input shape (the contradiction golden case). When `src/lib/handoff/packet.ts` and
`src/lib/handoff/render-markdown.ts` are built, this example doubles as the fixture
for the first renderer test:

```ts
// src/lib/handoff/render-markdown.test.ts (planned)
it("renders the contradiction_split_service_failure case as documented", () => {
  const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
  expect(renderPacketMarkdown(packet)).toMatchSnapshot(
    "docs/examples/packet-contradiction-split-service.md"
  );
});
```
