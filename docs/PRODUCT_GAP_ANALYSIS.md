# Product gap analysis

Audited against the advertising-intelligence loop, not against the presence of a screen. Status is what the running code does after this reconstruction.

| Capability | Intended behavior | Current implementation | Status | Missing work | Priority |
| --- | --- | --- | --- | --- | --- |
| Identity, organizations, roles | A user belongs to organizations and cannot read another tenant | Session middleware plus membership checks on every brand read and write | COMPLETE | Email delivery for invites | Low |
| Brand Brain | Structured, versioned, editable brand knowledge that later steps must use | Audience, positioning, voice, compliance fields, provenance, versions. Suggestions stay pending until accepted | PARTIAL | Logo file, palette, and typography are not stored as assets | Medium |
| Products and claims | Product facts constrain generation and QA | Products store allowed and prohibited claims. Guardian reads them | COMPLETE | — | — |
| Asset system | Durable files for logos and rendered media | Generated image URL can be stored. No upload pipeline | PARTIAL | Uploads, logo matching inputs | Medium |
| Market intelligence | Pluggable sources with provenance, or an honest empty state | Manual observations and one public-page fetch. Ad library adapter is declared and not implemented | PARTIAL | A real ad-library or platform connector | High |
| Competitor intelligence | Collected, normalized creatives. No fabricated ads | User-confirmed competitors and pasted creatives only | PARTIAL | Automated collection | High |
| Creative collection | Normalize any source into a creative record | `creative_records` with origin, source URL, fingerprint dedupe | PARTIAL | Only manual and generated origins are populated | Medium |
| Creative analysis | Decompose creatives into queryable attributes | Angle, hook, format, proof, offer, CTA, and claim are stored and queryable. No free-text classifier | PARTIAL | Model extraction from unstructured ads | Medium |
| Knowledge relationships | Query similar and matching attribute sets | In-process attribute match and Jaccard similarity over stored rows | PARTIAL | Not a separate graph database. Enough to query; not a visual graph | Low |
| JEV decision engine | Typed, versioned, evidence-in, threshold-out, persisted | `opportunity_gate.v2` computes probability from component questions. It no longer accepts a rank score. Text QA, brief, vision, positioning, and reproducibility questions persist through the same `decide()` function | PARTIAL | Reviewer disagreement is stored and does not move thresholds. Not every spec question is a separate persisted row; components are stored on the opportunity decision | Medium |
| Opportunity engine | Rank what to make from market, brand, history, failures, and saturation | Deterministic ranker. Priors are explicit. Angles outside that list are added only from stored competitor rows or positive learned patterns. Rank score and JEV probability are separate | PARTIAL | No external market feed. Cold starts are still mostly priors | High |
| Brand Guardian | Vision or text evidence, then JEV | Text guardian emits structured evidence and does not approve. After an image is generated, a vision model may return structured evidence; if it is not configured or the JSON is unusable, visual QA stays HUMAN_REVIEW and does not invent a score | PARTIAL | No logo asset to match against. Vision runs only on generated image URLs | High |
| Learning | Patterns emerge from observations and affect the next rank and brief | CTR, conversion rate, and ROAS are aggregated with a sample policy. Positive lift becomes historical support. Negative lift raises risk. The next brief includes the matching pattern | PARTIAL | Manual performance only. No schedule | High |
| Why this recommendation | Evidence, scores, decision, and expected learning are visible | Opportunity cards list the evidence lines, component scores, and JEV decision | COMPLETE | — | — |
| Creative brief | Brief is built from the opportunity plus retrieved knowledge | `buildBrief` copies constraints, learned patterns, and rejection counts into a stored brief | COMPLETE | — | — |
| Workflow templates | A creative is a structure with swappable variables | UGC, testimonial, and offer-card templates. Variables change without changing stages | COMPLETE | Fewer templates than a full studio | Low |
| Creative production | Provider-backed generation, or an honest unavailable state | Human compose always works. Text generation calls xAI or OpenRouter only when that key exists. Image generation is a separate user action | PARTIAL | No video generation | Medium |
| Human review | AUTO_APPROVE, HUMAN_REVIEW, REJECT are first-class | Review queue persists reviewer, reason, and time on the decision row | COMPLETE | — | — |
| Creative library and trace | Opportunity → brief → decision → asset → performance → learning | Trace view reads those links when they exist | COMPLETE | — | — |
| Experiments | A test is a record, not a chart | A running experiment row is opened when performance is entered | PARTIAL | No traffic split or platform publish | Medium |
| Performance | Observations attached to creative attributes | Manual entry only. The screen says no ad account is connected | PARTIAL | Platform connectors | High |
| Self-improvement loop | The next opportunity and brief retrieve what was learned | Proven by `loop.test.ts`: learned CTR changes rank order, a non-catalog angle from a learned pattern becomes a candidate, and the next brief includes that pattern | PARTIAL | Does not retrain a model. Performance is entered by hand | Medium |
| Failure memory | Rejections change future risk | Repeated unsupported or prohibited rejections raise risk on high-claim angles | COMPLETE | — | — |
| Provider routing | More than one provider behind an interface | xAI if `XAI_API_KEY` is set, else OpenRouter if its key is set, else unavailable | PARTIAL | No embeddings provider | Low |
| Prompt registry | Versioned prompts, recorded on each run | Code registry plus `prompt_versions` and `model_runs` | COMPLETE | No offline prompt-quality score beyond the JEV fixtures | Low |
| Audit | Who changed what, including decisions | Audit log plus JEV decision log with correlation id | COMPLETE | — | — |
| Automation | Jobs that still cannot publish on confidence alone | User-initiated actions only. Automation level is stored and unread | SCAFFOLD ONLY | A worker | Low |
| Multi-tenant isolation | Another org's rows never enter ranking or learning | Membership checks on server functions. Ranker and learner throw if a foreign id is passed in | COMPLETE | No browser-level cross-tenant integration test in CI | Medium |
| Evaluation harness | Repeatable fixtures for the gate and the loop | `evals/jev/cases.json` plus node tests for JEV, guardian, learning, and the write-back loop | PARTIAL | No held-out prompt eval against a live model | Medium |
| Observability | Provider, model, latency, tokens, status, correlation id | `model_runs` for suggest and generate. Secrets are not stored | PARTIAL | No cost ledger | Low |
| Publishing | Ship an approved creative to a platform | Not built. There is no publish button that pretends | MISSING | Platform APIs | Later |

What is still not true: there is no ad-library connector, no platform publish, and no performance feed. An unconfigured vision model does not invent a visual score. Priors are not market findings.
