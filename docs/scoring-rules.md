# Scoring Rules & Deterministic Ranking Engine

## 1. ICPC Deterministic Standings Formula

Shodh a Code implements the standard **International Collegiate Programming Contest (ICPC)** scoring model. Standings are computed strictly from **authoritative submission attempts** associated with each participant.

### 1.1 Solved Problems & Score
- Each problem has an alias letter (`A`, `B`, `C`) and a point value (default: 100 points).
- A problem is considered **Solved** if and only if the participant has at least one authoritative submission attempt with verdict `ACCEPTED`.
- A solved problem awards full points (100) toward the participant's total score. Submissions that do not achieve `ACCEPTED` (e.g. `WRONG_ANSWER`, `TIME_LIMIT_EXCEEDED`, `RUNTIME_ERROR`) award 0 points.

### 1.2 Penalty Time Calculation
The penalty time for problem $P$ is calculated as:
$$\text{Penalty}(P) = \begin{cases} 
T_{\text{solve}} + (K_{\text{failed}} \times P_{\text{failed}}) & \text{if } P \text{ is solved} \\
0 & \text{if } P \text{ is never solved}
\end{cases}$$

Where:
- $T_{\text{solve}}$ is the elapsed time in seconds from the contest `startTime` to the timestamp of the first `ACCEPTED` submission.
- $K_{\text{failed}}$ is the number of rejected attempts on problem $P$ submitted **strictly before** the first accepted submission.
- $P_{\text{failed}}$ is the contest penalty constant (default: 1200 seconds / 20 minutes).
- **Post-Accepted Submissions**: Any submissions made to problem $P$ after it has already been solved are ignored and do **not** add to the penalty.
- **Unsolved Problems**: Failed submissions on problems that are never solved during the contest do **not** incur penalty.

### 1.3 Deterministic Tie-Breaking Order
To ensure 100% reproducible rankings regardless of request order or database collation:
1. **Total Score / Solved Problems** (descending): Higher score ranks first.
2. **Total Penalty Time** (ascending): Lower penalty time ranks first.
3. **Latest Accepted Submission Time** (ascending): Earlier time of the last accepted problem breaks ties.
4. **User UUID** (lexicographical ascending): Strict tie-breaker ensuring deterministic, stable ranking order across multiple database queries.

---

## 2. Rejudging & Authoritative Attempt Precedence

When an organizer triggers a rejudge on a submission:
1. The historical attempt records are preserved in their entirety.
2. A new `SubmissionAttempt` is created with an incremented `attemptNumber` and a monotonically increasing `fencingToken`.
3. **Authoritative Result**: The newly completed rejudge attempt becomes the authoritative record for the submission. The previous attempt's `isAuthoritative` flag is set to `false`.
4. Standings are recalculated atomically within the same database transaction.
5. **Delayed Replaced Attempts**: If a worker processing an older attempt returns after a newer rejudge attempt has already completed, the older attempt's fencing token will be less than the authoritative attempt's fencing token ($T_{\text{old}} < T_{\text{authoritative}}$). The older attempt is rejected and marked `isAuthoritative: false`, preventing stale data from corrupting standings.

---

## 3. Serving Path vs. Standings Rebuild Verification

Clients observe leaderboard standings via `LeaderboardRow` records updated transactionally upon attempt completion.
To prove zero drift between the real-time serving path and authoritative ground truth, the endpoint `POST /api/v1/contests/:contestId/leaderboard/rebuild` recalculates standings from ground-truth submissions and asserts:
$$\text{Serving Standings} \equiv \text{Rebuilt Standings}$$

Verification tests in `test/run-all-verifications.ts` prove this equivalence holds under all execution scenarios.
