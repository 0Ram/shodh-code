# Shodh a Code: System Architecture & Technical Specifications

## 1. Overview and High-Level Design

**Shodh a Code** is a high-reliability online coding contest platform backend built with TypeScript and NestJS, PostgreSQL 16, and isolated Docker-based execution sandboxes. The system is engineered around **four core pillars of distributed backend reliability**:
1. **Data Consistency**: Strict relational constraints, immutable problem and test-suite versioning, and deterministic tie-breaking rules.
2. **Asynchronous Processing**: Decoupled submission ingestion using a Transactional Outbox pattern and atomic worker leases via PostgreSQL row-level locks (`FOR UPDATE SKIP LOCKED`).
3. **Fault Tolerance & Fencing**: Attempt fencing tokens to reject out-of-order or stale results, persistent idempotency keys surviving service restarts, and automated lease recovery for abandoned work.
4. **Defense-in-Depth Security**: Tenant boundary enforcement on every read/write, isolation between organizers and participants, non-root sandboxed execution with zero network access and bounded compute limits.

```
                         +-----------------------------+
                         |      HTTP Clients           |
                         | (Participants / Organizers) |
                         +--------------+--------------+
                                        |
                                        v
                         +-----------------------------+
                         |      NestJS API Gateway     |
                         |   (Auth, Guards, Routing)   |
                         +--------------+--------------+
                                        |
          +-----------------------------+-----------------------------+
          |                             |                             |
          v                             v                             v
+--------------------+        +--------------------+        +--------------------+
|    Auth & Orgs     |        |      Contests      |        |    Submissions     |
| (JWT & Tenant RBAC)|        |  (Lifecycle & Reg) |        | (Idempotent Ingest)|
+--------------------+        +--------------------+        +--------------------+
          |                             |                             |
          +-----------------------------+-----------------------------+
                                        |
                                        v
                       +-------------------------------+
                       |       PostgreSQL Engine       |
                       | - Business Tables             |
                       | - Transactional Outbox Events |
                       | - JudgeJob Queue (Leases)     |
                       | - Authoritative Leaderboard   |
                       +---------------+---------------+
                                       |
                   +-------------------+-------------------+
                   | FOR UPDATE SKIP LOCKED                | FOR UPDATE SKIP LOCKED
                   v                                       v
         +-------------------+                   +-------------------+
         |  Judge Worker 1   |                   |  Judge Worker 2   |
         | (Lease Claimer &  |                   | (Competing Worker |
         |  Attempt Fencing) |                   |  Multi-Process)   |
         +---------+---------+                   +---------+---------+
                   |                                       |
                   +-------------------+-------------------+
                                       |
                                       v
                        +-----------------------------+
                        |    Runner Service Factory   |
                        |   (Docker / Subprocess)     |
                        +--------------+--------------+
                                       |
                                       v
                        +-----------------------------+
                        |   Isolated Docker Sandbox   |
                        |  - Non-root user (1000)     |
                        |  - Network: none            |
                        |  - Memory: 128MB, CPU: 1.0  |
                        |  - PIDs: 64, Read-only FS   |
                        +-----------------------------+
```

---

## 2. Component Responsibilities

### 2.1 API Service (Ingress & Business Validation)
- Authenticates actors via cryptographic JWTs and development fixtures.
- Validates requests using class-validator and maps business errors to explicit HTTP status codes (separating `400 Bad Request`, `403 Forbidden`, `409 Conflict`, `422 Unprocessable Entity`, and `500 Internal Error`).
- Enforces organization-level tenant boundaries and role boundaries on all endpoints.
- Ingests submissions idempotently and commits submission + initial attempt + judge job + outbox event in a single atomic database transaction.
- Returns submission identifier immediately to the caller without waiting for judging to complete.

### 2.2 Asynchronous Judge Workers
- Compete concurrently for work using PostgreSQL row-level locks:
  ```sql
  SELECT "id", "submissionId", "attemptId", "retryCount"
  FROM "JudgeJob"
  WHERE "status" = 'QUEUED' OR ("status" = 'RETRYABLE' AND "leaseExpiresAt" <= NOW())
  ORDER BY "priority" DESC, "createdAt" ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  ```
- Acquire time-bounded leases (`leaseExpiresAt = NOW() + 15s`).
- Periodically scan for and recover abandoned jobs whose leases expired due to worker process crashes.
- Orchestrate program execution against versioned test cases.
- Enforce **Attempt Fencing**: compares attempt fencing token against the current authoritative attempt token; stale attempts from older workers or replaced rejudges are recorded for diagnostics but strictly forbidden from overwriting standings.
- Transactionally update the submission verdict, score, and leaderboard ranking upon completion.

### 2.3 Sandboxed Execution Engine (Docker Runner)
- Executes submitted code inside the hardened Docker image `shodh-runner:latest`.
- Enforces strict Linux cgroup and namespace isolation:
  - `--network none`: completely disables network access (blocks socket calls, raw sockets, outbound connections).
  - `--memory 128m`: hard memory cap; prevents OOM on the host.
  - `--cpus 1.0`: limits CPU scheduling shares.
  - `--pids-limit 64`: defends against fork bombs.
  - `--user 1000:1000`: executes as unprivileged user `sandbox`.
  - `--read-only`: mounts container root filesystem as read-only.
  - `--tmpfs /tmp:rw,noexec,nosuid,size=32m`: bounded in-memory temporary directory for script execution.
  - `--cap-drop ALL` and `--security-opt no-new-privileges`: strips all kernel capabilities.
- Driver script `execute.py` measures wall-clock time, captures standard output up to 64KB, catches division by zero / exceptions, and enforces timeouts.

---

## 3. Transaction Boundaries & Invariant Protection

| Operation | Tables Involved in Single ACID Transaction | Invariant Protected |
| :--- | :--- | :--- |
| **Submission Ingestion** | `Submission`, `SubmissionAttempt`, `JudgeJob`, `OutboxEvent`, `IdempotencyRecord` | Guarantees that every persisted submission has an initialized attempt and a queued judge job. A crash of the API process immediately after committing will never lose a submission. |
| **Worker Lease Acquisition** | `JudgeJob`, `SubmissionAttempt`, `Submission` | Prevents two workers from claiming the same job or advancing the attempt state concurrently. |
| **Authoritative Verdict Finalization** | `Submission`, `SubmissionAttempt`, `JudgeJob`, `LeaderboardRow` | Ensures that attempt completion, submission authoritative verdict promotion, job completion, and leaderboard recalculation occur atomically. Prevents double-scoring or partial ranking updates. |
| **Rejudging Initialization** | `SubmissionAttempt`, `Submission`, `JudgeJob`, `OutboxEvent` | Preserves historical attempts while enqueuing a new attempt with an incremented attempt number and higher fencing token. |
| **Organization Creation** | `Organization`, `OrganizationMember` | Guarantees that every organization is immediately linked with its creator as an authorized `ORGANIZER`. |

---

## 4. State Machines

### 4.1 Submission Lifecycle State Machine
```
   [CREATED / INGESTED]
             |
             v
          QUEUED <-------------+ (Worker crash recovery / Retryable failure)
             |                 |
             v                 |
          RUNNING -------------+
             |
             +---------> COMPLETED (Authoritative attempt evaluated)
             |
             +---------> FAILED (Exhausted retries on judge infrastructure failure)
```

### 4.2 Attempt Fencing State Machine
```
   Attempt #1 (Token: 1000) [RUNNING on Worker 1 - delayed]
   Attempt #2 (Token: 2000) [Rejudge triggered by Organizer, RUNNING on Worker 2]
             |
             v
   Attempt #2 finishes first:
     -> Token 2000 >= Authoritative Token (null)
     -> Promoted to AUTHORITATIVE
     -> Standings updated for Attempt #2
             |
             v
   Attempt #1 finishes late:
     -> Token 1000 < Authoritative Token (2000)
     -> REJECTED BY FENCING RULE
     -> Status set to COMPLETED (Diagnostic), isAuthoritative = false
     -> Standings REMAIN AUTHORITATIVE FOR ATTEMPT #2
```
