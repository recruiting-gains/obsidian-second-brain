---
date: 2026-09-04
type: roadmap
tags:
  - learning
  - fde
  - roadmap
ai-first: true
classification: private-local
status: active
target-role: forward-deployed-engineer
review-cadence: weekly
source-check: 2026-09-04
next-source-check: 2026-12-04
---

# Forward Deployed Engineer Roadmap

## For future agent

This is an evidence-gated path toward Forward Deployed Engineering. Its spine is one escalating
delivery project: make this AI second-brain useful for a real workflow while repeatedly practicing
discovery, scoping, design, implementation, deployment, evaluation, security, explanation, and
handoff. Skip material already demonstrated; never equate consumption with mastery.

Current FDE role descriptions emphasize production ownership across discovery, technical scoping,
system design, rollout, adoption, workflow impact, and product feedback, alongside strong software,
data, AI, and customer-facing judgment. Recheck the live role market quarterly: [OpenAI FDE role](https://openai.com/careers/forward-deployed-engineer-seoul-seoul-south-korea/)
and [Palantir FDSE role](https://jobs.lever.co/palantir/5168e8fd-fec1-4fea-b7a1-81bdaea65850).

## How progression works

Use levels `0–4` for every competency:

| Level | Observable capability | Next assignment |
|---:|---|---|
| 0 | Cannot yet explain or perform it | Core lesson + guided micro-build |
| 1 | Can follow a worked example | Modified example without step-by-step instructions |
| 2 | Can complete it with hints | Independent feature or investigation |
| 3 | Can complete, test, and explain it independently | Failure, performance, or trade-off exercise |
| 4 | Can operate under failure, teach it, and choose sound trade-offs | Peer review or real field task |

Advance from demonstrated artifacts. Two independent successes may accelerate a gate. A failed
delayed reassessment reopens only the affected competency. Use a weekly rhythm of roughly 20% study,
60% building/debugging, and 20% closed-book retrieval, explanation, and reflection.

Nominal duration is 30 weeks at 6-8 hours per week; the evidence gates, not the dates, control pace.

## Gate 0 - Baseline and field notebook

Nominal time: 1 week. Complete [[40 Learning/Assessments/Baseline Assessment]]. Start at the earliest
later gate with any required competency below level 3.

Evidence: original prompt, artifact, test/output log, five-minute explanation, rubric score, specific
mistakes, and next reassessment date.

## Gate 1 - Software engineering foundations

Nominal time: 3 weeks or skip by assessment.

Study selectively:

- [Harvard CS50P](https://cs50.harvard.edu/python/) - free video lectures, problem sets, testing,
  file I/O, regular expressions, object-oriented programming, and a final project.
- [MIT Missing Semester](https://missing.csail.mit.edu/2026/) - free recordings, notes, and exercises
  on shell tools, Git, debugging, packaging, and automation.
- [Pro Git](https://git-scm.com/book/en/v2) - use as a reference rather than a cover-to-cover task.

Build: harden `scripts.local_brain` so JSON, Markdown, and image metadata validate against contracts,
hash stably, archive immutably, retry idempotently, emit structured run summaries, and pass malformed-
input tests without credentials in code.

Gate evidence:

- Green unit and integration tests
- Two reviewed changes
- One design note
- Reproducible clean-checkout demo
- Delayed debugging reassessment after one month

## Gate 2 - Full-stack product engineering

Nominal time: 4 weeks.

Study [University of Helsinki Full Stack Open](https://fullstackopen.com/en/), prioritizing Parts 0-5
and then the relevant TypeScript, CI/CD, container, and relational-database material.

Build: a local review application for pending, accepted, quarantined, and rejected inbox items. It
must expose provenance and timestamps, safe retry/reprocess controls, search/filtering, accessible
keyboard operation, a versioned API, and API/browser tests. No automatic publication or irreversible
deletion.

Gate evidence: five-minute demo, API schema, test report, accessibility checklist, one architecture
decision record, and a successful setup by another person or isolated environment.

## Gate 3 - Systems and networking

Nominal time: 3 weeks.

Study selectively:

- [Operating Systems: Three Easy Pieces](https://pages.cs.wisc.edu/~remzi/OSTEP/) and its
  [homework simulators](https://pages.cs.wisc.edu/~remzi/OSTEP/Homework/homework.html): processes,
  concurrency, files, persistence, and distributed-systems fundamentals.
- [Stanford CS144](https://cs144.github.io/) warm-ups and measurement exercises for TCP/networking.
- Docker's official [hands-on introduction](https://docs.docker.com/get-started/introduction/).

Build a fault laboratory: interrupt a write, redeliver a duplicate, delay a dependency, exhaust a
pool, corrupt a derived temporary file, and restart an interrupted import. Predict behavior first;
then prove raw data stays intact.

Gate evidence: failure matrix, recovery runbook, reproducible fault fixtures, blameless postmortem,
and proof that recovery did not mutate raw archives.

## Gate 4 - Data engineering and provenance

Nominal time: 3 weeks.

Study:

- [PostgreSQL official tutorial](https://www.postgresql.org/docs/current/tutorial.html) for queries,
  joins, transactions, views, keys, and window functions.
- [DuckDB guides](https://duckdb.org/docs/current/guides/overview) for local JSON/CSV/Parquet analysis.
- Add orchestration only if complexity warrants it: [Airflow tutorials](https://airflow.apache.org/docs/apache-airflow/stable/tutorial/index.html).
- Use [dbt developer guides](https://docs.getdbt.com/guides) later for tested transformations.

Build one public or synthetic pipeline through immutable raw event → validated envelope → normalized
entity → deduplicated canonical record → derived note → reconciliation/freshness report. Exercise
duplicates, out-of-order and late events, checkpoint recovery, tombstones, schema evolution, and
backfills. Preserve user prose during regeneration.

Gate evidence: data contract, edge-case fixtures, reconciliation report, lineage diagram, migration
and rollback plan, and three consecutive reruns with no unintended drift.

## Gate 5 - Cloud delivery, reliability, and operations

Nominal time: 4 weeks. Choose one cloud first.

Study one path plus common operations material:

- Azure: [cloud fundamentals](https://learn.microsoft.com/en-gb/training/paths/microsoft-azure-fundamentals-describe-cloud-concepts/)
  and [guided projects](https://learn.microsoft.com/en-us/training/paths/introduction-cloud-infrastructure-apply-azure-skills-guided-projects/).
- Or AWS: [Cloud Essentials](https://aws.amazon.com/training/learn-about/cloud-practitioner/) and the
  [Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html).
- [GitHub Actions quickstart](https://docs.github.com/en/actions/get-started/quickstart).
- [Terraform tutorials](https://developer.hashicorp.com/terraform/tutorials), beginning locally.
- [Kubernetes Basics](https://kubernetes.io/docs/tutorials/kubernetes-basics/) only after a real
  orchestration need appears.
- [OpenTelemetry demo](https://opentelemetry.io/docs/demo/) and the free
  [Google SRE books](https://sre.google/sre-book/table-of-contents/).

Deploy only a sanitized, non-private version with infrastructure as code, CI/CD, external secrets,
health checks, versioned releases, rollback, restore testing, metrics/logs/traces, an SLO, budget
alerts, and teardown instructions. Run a game day after defining recovery and data-loss objectives.

Gate evidence: deployment record, sanitized diagram, infrastructure plan, SLO/dashboard, restore
evidence, runbook, game-day postmortem, and teardown confirmation for temporary resources.

## Gate 6 - LLM application engineering and evaluation

Nominal time: 4 weeks.

Study:

- OpenAI's official [Responses API](https://developers.openai.com/api/docs/guides/responses),
  [retrieval](https://developers.openai.com/api/docs/guides/retrieval),
  [Agents SDK](https://developers.openai.com/api/docs/guides/agents), and
  [evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices).
- [Full Stack Deep Learning LLMOps](https://fullstackdeeplearning.com/llm-bootcamp/spring-2023/llmops/)
  for a free video, slides, and practical evaluation/deployment material.
- Optional: [Hugging Face Agents Course](https://huggingface.co/learn/agents-course/en/unit0/introduction)
  for readings, quizzes, assignments, observability, and a benchmark project.

Build a provenance-first vault assistant with permission-filtered retrieval, exact plus semantic
search where justified, source/date/privacy/freshness filters, citations, structured actions, a narrow
allowlist, confirmation for destructive or external effects, abstention, provider abstraction, and a
mocked or local mode.

Build the eval set alongside it: normal, edge, adversarial, and historical-failure cases; citation
correctness; retrieval recall/precision; unsupported-claim abstention; tool selection/arguments;
privacy enforcement; latency/cost; and human-scored usefulness. Calibrate model graders against human
judgments rather than relying on vibes or copied thresholds.

Gate evidence: versioned 50+ case set, held-out results, human-calibration sample, failure taxonomy,
baseline-versus-candidate report, CI regression check, and a trace from failure to retrieval/tool event.

## Gate 7 - Security, privacy, and governance

Nominal time: 3 weeks.

Study:

- [OWASP Top 10:2025](https://owasp.org/www-project-top-ten/).
- [OWASP Top 10 for LLM and GenAI applications:2025](https://genai.owasp.org/llm-top-10/).
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework) and
  its [Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf).
- [PortSwigger Web Security Academy](https://portswigger.net/web-security) for free, practical labs.

Threat-model the vault assistant and implement least privilege, secret scanning and rotation,
dependency pinning, input/output validation, SSRF defenses, prompt-injection fixtures, retrieval and
tool authorization, rate/token/cost limits, redaction, export/deletion workflows, incident response,
and an SBOM where practical.

Gate evidence: threat model, risk register mapped to tests, red-team report, secret/dependency scan,
remediation changes, and a retest proving high-severity findings are closed.

## Gate 8 - Forward-deployed residency capstone

Nominal time: at least 4 weeks with one consenting real user or small team.

Study and practice:

- GOV.UK's [in-depth interview guide](https://www.gov.uk/service-manual/user-research/using-in-depth-interviews).
- Y Combinator's [user-interview recap](https://www.ycombinator.com/blog/startup-school-week-1-recap-kevin-hale-and-eric-migicovsky/).
- [Google Technical Writing](https://developers.google.com/tech-writing).
- AWS [architecture decision record guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/adr-process.html).
- [Diátaxis](https://diataxis.fr/) for tutorials, how-to guides, reference, and explanation.
- Google SRE's [postmortem practice](https://sre.google/workbook/postmortem-culture/).

Capstone cycle:

1. Conduct at least five interviews or observations with consent.
2. Document current workflow, pain, constraints, stakeholders, security boundary, and baseline.
3. Write a one-page problem and success brief.
4. Present two or three solution options with trade-offs.
5. Agree on the smallest usable pilot.
6. Ship weekly increments and demos.
7. Measure completion, adoption, quality, latency, reliability, and cost.
8. Turn field failures into tests and evals.
9. Deliver training, runbook, architecture, ADRs, and handoff.
10. Present once to engineers and once as an executive update.
11. Capture a retrospective and next recommendation.

Final gate: a real user completes the target workflow; measured outcomes improve or justify a clear
decision not to proceed; reliability/data/eval/security gates pass; another person can operate the
handoff; and Cruz can defend scope, design, trade-offs, and residual risks.

## Retrieval and spacing policy

Use approximate review intervals of 1, 3, 7, 14, 30, 60, and 90 days, then adapt them to observed
recall and desired retention. Prioritize cards from mistakes, failed tests, bad predictions,
architecture decisions, security findings, incidents, customer objections, and concepts Cruz could
use but not explain. Do not turn every paragraph into a card.

Practice testing and distributed practice have strong evidence; spacing depends on retention horizon:
[Dunlosky et al. review](https://pubmed.ncbi.nlm.nih.gov/26173288/),
[Karpicke and Roediger](https://doi.org/10.1126/science.1152408), and
[Cepeda et al.](https://pubmed.ncbi.nlm.nih.gov/19076480/).
