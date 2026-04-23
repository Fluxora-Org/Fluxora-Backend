# Security

## Safe Sweep — Recovering Accidental Token Deposits

### Problem

Tokens sent directly to the contract address (rather than through the streaming
protocol) are not tracked by any stream record. Without a recovery mechanism
they are permanently locked. The sweep endpoint lets an operator reclaim those
excess tokens while providing a machine-checkable proof that no recipient funds
are touched.

### Invariant

```
sweepable = contractBalance − outstandingLiabilities
```

`outstandingLiabilities` is the sum of `depositAmount` across every stream that
still owes tokens to a recipient:

| Stream status | Liability counted |
|---|---|
| `active` | full `depositAmount` |
| `paused` | full `depositAmount` |
| `scheduled` | full `depositAmount` |
| `completed` (awaiting recipient close) | full `depositAmount` |
| `cancelled` (undrawn accrual) | full `depositAmount` (conservative) |
| `depleted` | none — fully streamed out |

The calculation is performed in integer arithmetic scaled to 7 decimal places
(`BigInt` with `SCALE_FACTOR = 10^7`) to avoid floating-point drift.

### Endpoint

```
POST /api/admin/sweep
Authorization: Bearer <ADMIN_API_KEY>

{
  "contractBalance": "1000.0000000",
  "requestedAmount": "50.0000000"
}
```

The endpoint **does not execute a transfer**. It validates the invariant and
returns the computed `sweepableAmount`. The operator is responsible for
submitting the on-chain transaction only after receiving a `200` response.

**Responses:**

| Status | Meaning |
|---|---|
| `200` | Sweep is safe; `sweepableAmount`, `totalLiabilities`, `contractBalance` returned |
| `400` | Invalid input or `requestedAmount > sweepableAmount` (invariant violation) |
| `401` | Missing `Authorization` header |
| `403` | Wrong admin token |
| `503` | `ADMIN_API_KEY` not configured |

### Trust Boundaries

| Actor | May do | May not do |
|---|---|---|
| Public internet clients | Nothing — endpoint is admin-only | Call sweep endpoint |
| Authenticated partners | Nothing — sweep is admin-only | Call sweep endpoint |
| Administrators / operators | Call sweep endpoint after verifying `sweepableAmount > 0` | Submit on-chain transfer for more than `sweepableAmount` |
| Internal workers | N/A | Trigger sweeps autonomously |

### Failure Modes

| Condition | Expected result |
|---|---|
| `contractBalance` is stale (lower than actual) | `sweepableAmount` is under-estimated — safe, conservative |
| `contractBalance` is inflated (higher than actual) | `sweepableAmount` is over-estimated — operator must verify on-chain before submitting |
| Stream record missing from service (indexer lag) | Liability is under-counted — operator should wait for indexer to catch up |
| `requestedAmount > sweepableAmount` | `400 INSUFFICIENT_BALANCE` — transfer is blocked |

### Implementation

- `src/lib/sweep.ts` — `calculateSweepable()` and `validateSweepRequest()`
- `src/routes/admin.ts` — `POST /api/admin/sweep` route
- `tests/sweep.test.ts` — unit and integration tests

### Non-Goals

- The endpoint does not submit the on-chain transaction. It is a pre-flight
  check only.
- It does not handle partial settlement or per-recipient withdrawal tracking.
  Those require on-chain state that is not yet indexed.
