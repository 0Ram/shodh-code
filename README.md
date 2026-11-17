# Shodh a Code — Coding Contest Platform Backend

[![Node.js](https://img.shields.io/badge/Node.js-v22-green.svg)](https://nodejs.org/)
[![NestJS](https://img.shields.io/badge/NestJS-v10-red.svg)](https://nestjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue.svg)](https://www.postgresql.org/)
[![Docker](https://img.shields.io/badge/Docker-Sandbox-blue.svg)](https://www.docker.com/)
[![Tests](https://img.shields.io/badge/Tests-15%20Passed-brightgreen.svg)]()

Production-grade coding contest platform backend featuring **transactional outbox job dispatch**, **asynchronous Docker execution sandboxes**, **PostgreSQL atomic row leases (`FOR UPDATE SKIP LOCKED`)**, **immutable problem/test-suite versioning**, and **attempt fencing**.

Built for the **Shodh AI Backend Engineer Intern Take Home Assessment**.

---

## 🚀 Quick Start (Single Command)

The entire platform—including PostgreSQL, the NestJS HTTP API Gateway, two competing background judge workers, and the Docker runner image—boots with one command:

```bash
docker compose up --build
```

- **API Base URL**: `http://localhost:3000`
- **Interactive Swagger / OpenAPI UI**: `http://localhost:3000/api/docs`
- **Database**: PostgreSQL 16 on `localhost:5432`

---

## 🧪 Functional Evaluation & Verification

To run the complete end-to-end verification harness across all four stages:

```bash
# Make script executable (if not already)
chmod +x scripts/verify.sh

# Run full functional evaluation
./scripts/verify.sh
```

Or via npm:

```bash
npm run test:all
```

This single command resets the database, runs deterministic seeding, and executes all 5 scenario suites:
1. **Normal Flow**: Participant contest registration, non-blocking submission ingestion, asynchronous judging, and deterministic standings.
2. **Retries & Concurrency**: Persistent idempotency replays, HTTP 409 conflict detection on modified payloads, two competing workers claiming jobs via `SKIP LOCKED`, and attempt fencing.
3. **Recovery & Rejudging**: Expired lease recovery for crashed workers, controllable runner failure injection with automated retry recovery, and organizer-driven rejudging.
4. **Security & Isolation**: Tenant-boundary cross-organization denial (HTTP 403), role authorization failure (HTTP 403), hidden test-case protection, and resource bounding (timeout, memory, output truncation).
5. **Standings Rebuild & Consistency**: Authoritative standing recalculation proving $100\%$ equivalence between the serving path and authoritative ground truth.

Saved audit evidence: [`results/verification-evidence.json`](results/verification-evidence.json).

---

## ⚡ Performance Workload & Bottleneck Investigation

Run the concurrent performance workload benchmark (70% leaderboard reads, 30% submission ingestion):

```bash
npm run benchmark
```

### Measured Performance Highlights:
- **Throughput**: `877 requests/second` (100% success rate, 0 errors)
- **Leaderboard Read Latency**: P50: **5 ms**, P95: **35 ms**, P99: **39 ms**
- **Submission Ingestion Latency**: P50: **16 ms**, P95: **31 ms**, P99: **49 ms**
- **Query Plan Optimization**: Investigated and eliminated in-memory sorting on leaderboard queries using composite index `CREATE INDEX idx_leaderboard_perf ON "LeaderboardRow" ("contestId", "score" DESC, "penaltyTimeSec" ASC);`. Execution time reduced to **0.029 ms**.

Saved benchmark evidence: [`results/benchmark-evidence.json`](results/benchmark-evidence.json).

---

## 👥 Deterministic Seed Identities & Fixtures

All fixture users share the password: `password123`.

| Email | Global Role | Organization | Organization Role | Primary Use Case |
| :--- | :--- | :--- | :--- | :--- |
| `superadmin@shodh.test` | `SUPERADMIN` | System-wide | Superadmin | Global administration |
| `organizer.alpha@shodh.test` | `USER` | `Alpha Tech Contest Org` | `ORGANIZER` | Creates contests, problems, triggers rejudge |
| `organizer.beta@shodh.test` | `USER` | `Beta University` | `ORGANIZER` | Tests cross-tenant isolation against Alpha |
| `student1@shodh.test` | `USER` | Alpha & Beta | `PARTICIPANT` | Submits code, checks leaderboard |
| `student2@shodh.test` | `USER` | Alpha | `PARTICIPANT` | Competes on Alpha leaderboard |
| `student3@shodh.test` | `USER` | Beta | `PARTICIPANT` | Member of Beta, blocked from Alpha |

*Tip: You can mint valid JWT tokens instantly without passwords via the development endpoint `POST /api/v1/auth/dev-tokens`.*

---

## 📐 Architecture & Key Design Decisions

```
+-------------------------------------------------------------+
|                     HTTP CLIENTS                            |
|             (Participants / Organizers)                     |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
|                  NestJS API GATEWAY                         |
|   - JWT Authentication & OrgRolesGuard                      |
|   - Input Validation & Explicit Exception Mapping           |
|   - Idempotent Ingestion (SHA-256 Request Hash Check)       |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
|                 POSTGRESQL 16 ENGINE                        |
|   - Business Persistence (Immutable Versions)               |
|   - Transactional Outbox (Submission + Attempt + Job)       |
|   - Row-Level Locking: FOR UPDATE SKIP LOCKED               |
|   - Authoritative Standings Cache                           |
+------------------------------+------------------------------+
                               |
            +------------------+------------------+
            | FOR UPDATE SKIP LOCKED              | FOR UPDATE SKIP LOCKED
            v                                     v
+--------------------------+         +--------------------------+
|      JUDGE WORKER 1      |         |      JUDGE WORKER 2      |
|  - Lease Claimer (15s)   |         |  - Competing Worker      |
|  - Attempt Fencing Token |         |  - Multi-Process Safe    |
|  - Crash Recovery Loop   |         |  - Stale Result Demotion |
+-------------+------------+         +------------+-------------+
              |                                   |
              +-----------------+-----------------+
                                |
                                v
+-------------------------------------------------------------+
|                 ISOLATED DOCKER SANDBOX                     |
|   - Base: Python 3.12 Alpine                                |
|   - User: 1000:1000 (Non-root 'sandbox')                    |
|   - Network: none (Air-gapped)                              |
|   - Limits: 128MB RAM, 1.0 CPU, 64 PIDs                     |
|   - Filesystem: Read-only root + Bounded 32MB /tmp          |
|   - Capabilities: --cap-drop ALL, no-new-privileges         |
+-------------------------------------------------------------+
```

### Why PostgreSQL Transactional Outbox over Redis/BullMQ?
Redis is an in-memory store that introduces separate failure domains. If an API process commits a submission to PostgreSQL but crashes before pushing to Redis, the submission is orphaned forever. With PostgreSQL transactional outbox, the submission, initial attempt, and judge job are committed in the **same atomic WAL transaction**. The job can never be lost, surviving restarts, crashes, and network partitions.

### Why Attempt Fencing?
When an organizer triggers a rejudge on a submission, older attempts might still be executing on delayed workers. Without fencing, an old worker finishing late could overwrite the newer authoritative verdict. Each attempt is tagged with a monotonically increasing `fencingToken`. Stale attempts whose token is lower than the authoritative attempt are rejected and marked non-authoritative.

---

## 📂 Repository Layout

```
.
├── src/
│   ├── auth/              # JWT auth, Passport strategy, dev fixture tokens
│   ├── common/            # Guards (OrgRolesGuard), exception filter, logger
│   ├── contests/          # Contest lifecycle, registration, problem linking
│   ├── organizations/     # Multi-tenant organization boundaries and members
│   ├── problems/          # Logical problems, immutable ProblemVersion & TestSuites
│   ├── submissions/       # Ingestion, idempotency checking, rejudging
│   ├── judge/
│   │   ├── outbox/        # Transactional outbox event dispatcher
│   │   ├── runner/        # Docker runner & deterministic subprocess runner
│   │   └── worker/        # JudgeWorkerService with SKIP LOCKED & attempt fencing
│   ├── leaderboard/       # ICPC scoring, tie-breaking, standings rebuild
│   ├── app.module.ts
│   ├── main.ts            # API Server Entrypoint
│   └── worker.main.ts     # Standalone Worker Entrypoint
├── runner/
│   ├── Dockerfile         # Hardened non-root sandbox container
│   └── execute.py         # Isolation driver measuring time/memory/output
├── prisma/
│   ├── schema.prisma      # Relational PostgreSQL schema
│   ├── migrations/        # Applied SQL migrations
│   └── seed.ts            # Deterministic seed bundle
├── test/
│   ├── integration/       # Stage 1 & 2 Normal flow verification
│   ├── concurrency/       # Stage 3 Idempotency & competing workers
│   ├── recovery/          # Stage 3 Abandoned work & runner failure recovery
│   ├── security/          # Stage 4 Cross-org denial & hidden data protection
│   └── run-all-verifications.ts # Master verification harness
├── load-tests/
│   └── workload-benchmark.ts # Repeatable benchmark & EXPLAIN ANALYZE analysis
├── docs/
│   ├── architecture.md    # System architecture & state machines
│   ├── database-design.md # Relational schema, ER diagram & indexing
│   ├── api-contracts.md   # Endpoint contracts & request/response examples
│   ├── scoring-rules.md   # ICPC scoring & tie-breaking rules
│   ├── performance-report.md # Benchmark results & bottleneck analysis
│   └── assessment-report.md  # 4-page technical report + AI disclosure
├── results/
│   ├── verification-evidence.json # Automated test results
│   └── benchmark-evidence.json    # Workload latency & query plan evidence
├── docker-compose.yml     # Multi-process container configuration
├── Dockerfile             # Multi-stage production build
└── package.json
```

---

## 📚 Technical Documentation Directory

For in-depth analysis and technical specifications, explore the documentation in [`docs/`](docs/):
- [Architecture & State Machines](docs/architecture.md)
- [Database Design & Immutability Patterns](docs/database-design.md)
- [API Contracts & Error Codes](docs/api-contracts.md)
- [Scoring Rules & Standings Rebuild Verification](docs/scoring-rules.md)
- [Performance & Query Plan Optimization Report](docs/performance-report.md)
- [Formal 4-Page Assessment Report & AI Disclosure](docs/assessment-report.md)
