# API Contracts & OpenAPI Specifications

The platform exposes RESTful endpoints with OpenAPI/Swagger definitions accessible at `/api/docs`.

## 1. Authentication & Fixtures

### `POST /api/v1/auth/login`
Authenticates a user with email and password.
- **Request Body**:
  ```json
  {
    "email": "student1@shodh.test",
    "password": "password123"
  }
  ```
- **Response `200 OK`**:
  ```json
  {
    "accessToken": "eyJhbGciOi...",
    "user": {
      "id": "uuid",
      "email": "student1@shodh.test",
      "name": "Alice Student",
      "globalRole": "USER",
      "memberships": []
    }
  }
  ```

### `POST /api/v1/auth/dev-tokens`
Trusted development fixture endpoint to mint JWT tokens for test automation and candidate verification without passwords.
- **Request Body**:
  ```json
  { "email": "organizer.alpha@shodh.test" }
  ```
- **Response `200 OK`**:
  ```json
  {
    "accessToken": "eyJhbGciOi...",
    "user": { ... }
  }
  ```

### `GET /api/v1/auth/me`
Retrieves current authenticated identity and organization roles.
- **Header**: `Authorization: Bearer <token>`
- **Response `200 OK`**:
  ```json
  {
    "id": "uuid",
    "email": "organizer.alpha@shodh.test",
    "name": "Alpha Organizer",
    "globalRole": "USER",
    "memberships": [
      {
        "id": "uuid",
        "organizationId": "uuid-alpha",
        "role": "ORGANIZER",
        "organization": { "name": "Alpha Tech Contest Org", "slug": "alpha-org" }
      }
    ]
  }
  ```

---

## 2. Contests API

### `POST /api/v1/organizations/:orgId/contests`
Creates a contest within an organization. Restricted to `ORGANIZER` of that organization.
- **Request Body**:
  ```json
  {
    "title": "Code Sprint 2026",
    "slug": "code-sprint-2026",
    "description": "Annual sprint",
    "startTime": "2026-11-17T10:00:00Z",
    "endTime": "2026-11-18T10:00:00Z",
    "scoringRule": "ICPC",
    "penaltyPerFailedAttemptSec": 1200
  }
  ```
- **Response `201 Created`**: Returns created contest metadata.

### `GET /api/v1/contests`
Lists all contests with pagination and stable ordering (`startTime DESC, id DESC`).
- **Query Params**: `page` (default 1), `limit` (default 20), `order` (default `desc`)
- **Response `200 OK`**:
  ```json
  {
    "data": [
      {
        "id": "uuid",
        "title": "Alpha Code Sprint 2026",
        "slug": "alpha-round-1",
        "status": "ACTIVE",
        "startTime": "2026-11-17T09:00:00Z",
        "endTime": "2026-11-18T09:00:00Z",
        "_count": { "participants": 2, "problems": 3, "submissions": 12 }
      }
    ],
    "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1, "hasNextPage": false, "hasPrevPage": false }
  }
  ```

### `POST /api/v1/contests/:id/register`
Registers the authenticated actor for a contest. Idempotent. Returns `422 Unprocessable Entity` if the contest has already completed.

---

## 3. Submissions API

### `POST /api/v1/contests/:contestId/submissions`
Ingests a solution program and queues it for asynchronous judging.
- **Headers**:
  - `Authorization: Bearer <token>`
  - `x-idempotency-key: <key>` (Optional header or body property)
- **Request Body**:
  ```json
  {
    "problemId": "uuid-problem-a",
    "language": "python3",
    "sourceCode": "a, b = map(int, input().split()); print(a + b)",
    "idempotencyKey": "idem-uuid-001"
  }
  ```
- **Response `201 Created`**:
  ```json
  {
    "id": "uuid-submission",
    "contestId": "uuid-contest",
    "problemId": "uuid-problem",
    "problemVersionId": "uuid-version",
    "status": "QUEUED",
    "verdict": "PENDING",
    "submittedAt": "2026-11-17T11:15:00Z",
    "attemptNumber": 1,
    "isIdempotentReplay": false
  }
  ```
- **Error Responses**:
  - `409 Conflict`: If `idempotencyKey` was already used by the actor with different source code or parameters.
  - `422 Unprocessable Entity`: If the contest is not active or actor is not registered.

### `GET /api/v1/submissions/:id`
Retrieves submission status, verdict, runtime metrics, and attempt history.
- **Access Control**:
  - Participant owner: can view status, verdict, execution metrics, own source code.
  - Contest organizer / Superadmin: full diagnostic access.
  - Non-owner participant: `403 Forbidden` (private code and status isolated).

### `POST /api/v1/submissions/:id/rejudge`
Triggers rejudging against an explicitly specified problem version or test-suite version.
- **Access Control**: Restricted to `ORGANIZER` or `SUPERADMIN`.
- **Request Body**:
  ```json
  {
    "problemVersionId": "uuid-version-2",
    "testSuiteVersionId": "uuid-suite-2"
  }
  ```
- **Response `201 Created`**:
  ```json
  {
    "submissionId": "uuid",
    "attemptId": "uuid-attempt-2",
    "attemptNumber": 2,
    "status": "QUEUED",
    "message": "Rejudging job enqueued successfully"
  }
  ```

---

## 4. Leaderboard API

### `GET /api/v1/contests/:contestId/leaderboard`
Returns current standings with deterministic ICPC rankings.
- **Response `200 OK`**:
  ```json
  {
    "data": [
      {
        "id": "uuid",
        "rank": 1,
        "userId": "uuid-user-1",
        "user": { "name": "Alice Student", "email": "student1@shodh.test" },
        "score": 200,
        "problemsSolved": 2,
        "penaltyTimeSec": 2480,
        "lastAcceptedAt": "2026-11-17T10:45:00Z",
        "detailJson": {
          "prob-a-id": { "solved": true, "failedAttemptsBeforeSolve": 0, "acceptedTimeSec": 120, "score": 100 },
          "prob-b-id": { "solved": true, "failedAttemptsBeforeSolve": 1, "acceptedTimeSec": 1160, "score": 100 }
        }
      }
    ],
    "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1, "hasNextPage": false, "hasPrevPage": false }
  }
  ```

### `POST /api/v1/contests/:contestId/leaderboard/rebuild`
Rebuilds the entire leaderboard from scratch from authoritative submission attempts and verifies 100% equivalence with serving path. Restricted to `ORGANIZER`.
