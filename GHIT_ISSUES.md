---
type: Feature
title: Backend bootstrap: environment configuration module
labels: backend, config, dx
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Backend bootstrap: environment configuration module—and should close gaps between what stakeholders expect and what the service actually guarantees. Document operational signals (health, metrics, logs) so on-call staff can diagnose incidents without tribal knowledge. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Backend bootstrap: environment configuration module

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Backend bootstrap: environment configuration module*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Backend bootstrap: environment configuration module* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: TypeScript strictness: enable strict compiler options
labels: backend, typescript, quality
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—TypeScript strictness: enable strict compiler options—and should close gaps between what stakeholders expect and what the service actually guarantees. Clarify trust boundaries between anonymous clients, authenticated partners, administrators, and internal workers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** TypeScript strictness: enable strict compiler options

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *TypeScript strictness: enable strict compiler options*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *TypeScript strictness: enable strict compiler options* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 72 hours

++++++

---
type: Feature
title: Lint/format: ESLint + Prettier baseline for Fluxora-Backend
labels: backend, dx, ci
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Lint/format: ESLint + Prettier baseline for Fluxora-Backend—and should close gaps between what stakeholders expect and what the service actually guarantees. Clarify trust boundaries between anonymous clients, authenticated partners, administrators, and internal workers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Lint/format: ESLint + Prettier baseline for Fluxora-Backend

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Lint/format: ESLint + Prettier baseline for Fluxora-Backend*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Lint/format: ESLint + Prettier baseline for Fluxora-Backend* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Task
title: Structured logging with request correlation IDs
labels: backend, observability
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Structured logging with request correlation IDs—and should close gaps between what stakeholders expect and what the service actually guarantees. Address abuse scenarios: oversized payloads, excessive request rates, and duplicate submissions, with predictable client-visible outcomes. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Structured logging with request correlation IDs

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Structured logging with request correlation IDs*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Structured logging with request correlation IDs* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Global error handler: normalize API error JSON
labels: backend, api, ux
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Global error handler: normalize API error JSON—and should close gaps between what stakeholders expect and what the service actually guarantees. Address abuse scenarios: oversized payloads, excessive request rates, and duplicate submissions, with predictable client-visible outcomes. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Global error handler: normalize API error JSON

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Global error handler: normalize API error JSON*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Global error handler: normalize API error JSON* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Input validation layer (zod/io-ts) for JSON bodies
labels: backend, api, security
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Input validation layer (zod/io-ts) for JSON bodies—and should close gaps between what stakeholders expect and what the service actually guarantees. Document operational signals (health, metrics, logs) so on-call staff can diagnose incidents without tribal knowledge. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Input validation layer (zod/io-ts) for JSON bodies

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Input validation layer (zod/io-ts) for JSON bodies*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Input validation layer (zod/io-ts) for JSON bodies* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: OpenAPI 3.1 specification for Fluxora HTTP API
labels: backend, api, docs
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—OpenAPI 3.1 specification for Fluxora HTTP API—and should close gaps between what stakeholders expect and what the service actually guarantees. Address abuse scenarios: oversized payloads, excessive request rates, and duplicate submissions, with predictable client-visible outcomes. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** OpenAPI 3.1 specification for Fluxora HTTP API

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *OpenAPI 3.1 specification for Fluxora HTTP API*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *OpenAPI 3.1 specification for Fluxora HTTP API* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Task
title: Health: deep checks for Postgres + Stellar RPC readiness
labels: backend, health, ops
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Health: deep checks for Postgres + Stellar RPC readiness—and should close gaps between what stakeholders expect and what the service actually guarantees. Document operational signals (health, metrics, logs) so on-call staff can diagnose incidents without tribal knowledge. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Health: deep checks for Postgres + Stellar RPC readiness

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Health: deep checks for Postgres + Stellar RPC readiness*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Health: deep checks for Postgres + Stellar RPC readiness* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Postgres connection pool with graceful config
labels: backend, database
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Postgres connection pool with graceful config—and should close gaps between what stakeholders expect and what the service actually guarantees. Address abuse scenarios: oversized payloads, excessive request rates, and duplicate submissions, with predictable client-visible outcomes. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Postgres connection pool with graceful config

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Postgres connection pool with graceful config*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Postgres connection pool with graceful config* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Database migrations framework (e.g. node-pg-migrate)
labels: backend, database, migrations
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Database migrations framework (e.g. node-pg-migrate)—and should close gaps between what stakeholders expect and what the service actually guarantees. Address abuse scenarios: oversized payloads, excessive request rates, and duplicate submissions, with predictable client-visible outcomes. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Database migrations framework (e.g. node-pg-migrate)

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Database migrations framework (e.g. node-pg-migrate)*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Database migrations framework (e.g. node-pg-migrate)* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Schema: streams table mapped from on-chain events
labels: backend, database, indexing
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Schema: streams table mapped from on-chain events—and should close gaps between what stakeholders expect and what the service actually guarantees. Address abuse scenarios: oversized payloads, excessive request rates, and duplicate submissions, with predictable client-visible outcomes. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Schema: streams table mapped from on-chain events

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Schema: streams table mapped from on-chain events*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Schema: streams table mapped from on-chain events* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Task
title: Indexes: recipient and sender query patterns
labels: backend, database, performance
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Indexes: recipient and sender query patterns—and should close gaps between what stakeholders expect and what the service actually guarantees. Define how the service behaves when dependencies are degraded (database, Stellar RPC, background workers) and how clients should interpret errors. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Indexes: recipient and sender query patterns

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Indexes: recipient and sender query patterns*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Indexes: recipient and sender query patterns* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Cursor pagination for /api/streams
labels: backend, api, pagination
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Cursor pagination for /api/streams—and should close gaps between what stakeholders expect and what the service actually guarantees. Define how the service behaves when dependencies are degraded (database, Stellar RPC, background workers) and how clients should interpret errors. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Cursor pagination for /api/streams

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Cursor pagination for /api/streams*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Cursor pagination for /api/streams* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: GET /api/streams filters: status, recipient, sender
labels: backend, api
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—GET /api/streams filters: status, recipient, sender—and should close gaps between what stakeholders expect and what the service actually guarantees. Ensure amounts, identities, and stream states crossing the chain/API boundary stay unambiguous for integrators and finance reviewers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** GET /api/streams filters: status, recipient, sender

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *GET /api/streams filters: status, recipient, sender*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *GET /api/streams filters: status, recipient, sender* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: GET /api/streams/:id backed by database
labels: backend, api
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—GET /api/streams/:id backed by database—and should close gaps between what stakeholders expect and what the service actually guarantees. Clarify trust boundaries between anonymous clients, authenticated partners, administrators, and internal workers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** GET /api/streams/:id backed by database

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *GET /api/streams/:id backed by database*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *GET /api/streams/:id backed by database* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Task
title: POST /api/streams: align with chain-first model
labels: backend, api, product
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—POST /api/streams: align with chain-first model—and should close gaps between what stakeholders expect and what the service actually guarantees. Clarify trust boundaries between anonymous clients, authenticated partners, administrators, and internal workers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** POST /api/streams: align with chain-first model

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *POST /api/streams: align with chain-first model*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *POST /api/streams: align with chain-first model* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Idempotency keys for unsafe POST operations
labels: backend, api, reliability
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Idempotency keys for unsafe POST operations—and should close gaps between what stakeholders expect and what the service actually guarantees. Ensure amounts, identities, and stream states crossing the chain/API boundary stay unambiguous for integrators and finance reviewers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Idempotency keys for unsafe POST operations

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Idempotency keys for unsafe POST operations*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Idempotency keys for unsafe POST operations* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Stellar RPC client wrapper with timeouts/retries
labels: backend, stellar, reliability
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Stellar RPC client wrapper with timeouts/retries—and should close gaps between what stakeholders expect and what the service actually guarantees. Clarify trust boundaries between anonymous clients, authenticated partners, administrators, and internal workers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Stellar RPC client wrapper with timeouts/retries

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Stellar RPC client wrapper with timeouts/retries*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Stellar RPC client wrapper with timeouts/retries* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Indexer worker: ingest contract events into Postgres
labels: backend, indexing, worker
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Indexer worker: ingest contract events into Postgres—and should close gaps between what stakeholders expect and what the service actually guarantees. Address abuse scenarios: oversized payloads, excessive request rates, and duplicate submissions, with predictable client-visible outcomes. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Indexer worker: ingest contract events into Postgres

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Indexer worker: ingest contract events into Postgres*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Indexer worker: ingest contract events into Postgres* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Task
title: Reorg handling: chain tip safety for indexer
labels: backend, indexing, reliability
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Reorg handling: chain tip safety for indexer—and should close gaps between what stakeholders expect and what the service actually guarantees. Define how the service behaves when dependencies are degraded (database, Stellar RPC, background workers) and how clients should interpret errors. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Reorg handling: chain tip safety for indexer

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Reorg handling: chain tip safety for indexer*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Reorg handling: chain tip safety for indexer* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Webhook dispatcher for stream lifecycle events
labels: backend, integrations
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Webhook dispatcher for stream lifecycle events—and should close gaps between what stakeholders expect and what the service actually guarantees. Document operational signals (health, metrics, logs) so on-call staff can diagnose incidents without tribal knowledge. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Webhook dispatcher for stream lifecycle events

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Webhook dispatcher for stream lifecycle events*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Webhook dispatcher for stream lifecycle events* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Webhook signature verification docs for consumers
labels: backend, integrations, security
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Webhook signature verification docs for consumers—and should close gaps between what stakeholders expect and what the service actually guarantees. Address abuse scenarios: oversized payloads, excessive request rates, and duplicate submissions, with predictable client-visible outcomes. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Webhook signature verification docs for consumers

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Webhook signature verification docs for consumers*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Webhook signature verification docs for consumers* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Rate limiting (per IP + per API key)
labels: backend, security
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Rate limiting (per IP + per API key)—and should close gaps between what stakeholders expect and what the service actually guarantees. Define how the service behaves when dependencies are degraded (database, Stellar RPC, background workers) and how clients should interpret errors. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Rate limiting (per IP + per API key)

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Rate limiting (per IP + per API key)*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Rate limiting (per IP + per API key)* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Task
title: API key authentication for server-to-server access
labels: backend, auth, security
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—API key authentication for server-to-server access—and should close gaps between what stakeholders expect and what the service actually guarantees. Clarify trust boundaries between anonymous clients, authenticated partners, administrators, and internal workers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** API key authentication for server-to-server access

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *API key authentication for server-to-server access*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *API key authentication for server-to-server access* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Optional JWT session auth for dashboard clients
labels: backend, auth
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Optional JWT session auth for dashboard clients—and should close gaps between what stakeholders expect and what the service actually guarantees. Document operational signals (health, metrics, logs) so on-call staff can diagnose incidents without tribal knowledge. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Optional JWT session auth for dashboard clients

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Optional JWT session auth for dashboard clients*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Optional JWT session auth for dashboard clients* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: CORS policy: explicit allowlist for production
labels: backend, security
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—CORS policy: explicit allowlist for production—and should close gaps between what stakeholders expect and what the service actually guarantees. Document operational signals (health, metrics, logs) so on-call staff can diagnose incidents without tribal knowledge. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** CORS policy: explicit allowlist for production

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *CORS policy: explicit allowlist for production*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *CORS policy: explicit allowlist for production* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Security headers: helmet middleware
labels: backend, security
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Security headers: helmet middleware—and should close gaps between what stakeholders expect and what the service actually guarantees. Document operational signals (health, metrics, logs) so on-call staff can diagnose incidents without tribal knowledge. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Security headers: helmet middleware

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Security headers: helmet middleware*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Security headers: helmet middleware* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Task
title: Request size limits and JSON depth protections
labels: backend, security
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Request size limits and JSON depth protections—and should close gaps between what stakeholders expect and what the service actually guarantees. Document operational signals (health, metrics, logs) so on-call staff can diagnose incidents without tribal knowledge. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Request size limits and JSON depth protections

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Request size limits and JSON depth protections*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Request size limits and JSON depth protections* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Graceful shutdown: drain HTTP + DB pool
labels: backend, ops, reliability
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Graceful shutdown: drain HTTP + DB pool—and should close gaps between what stakeholders expect and what the service actually guarantees. Document operational signals (health, metrics, logs) so on-call staff can diagnose incidents without tribal knowledge. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Graceful shutdown: drain HTTP + DB pool

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Graceful shutdown: drain HTTP + DB pool*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Graceful shutdown: drain HTTP + DB pool* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Dockerfile for production backend image
labels: backend, docker, ops
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Dockerfile for production backend image—and should close gaps between what stakeholders expect and what the service actually guarantees. Document operational signals (health, metrics, logs) so on-call staff can diagnose incidents without tribal knowledge. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Dockerfile for production backend image

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Dockerfile for production backend image*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Dockerfile for production backend image* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: docker-compose: app + postgres (+ redis optional)
labels: backend, docker, dx
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—docker-compose: app + postgres (+ redis optional)—and should close gaps between what stakeholders expect and what the service actually guarantees. Clarify trust boundaries between anonymous clients, authenticated partners, administrators, and internal workers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** docker-compose: app + postgres (+ redis optional)

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *docker-compose: app + postgres (+ redis optional)*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *docker-compose: app + postgres (+ redis optional)* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Task
title: CI pipeline: install, lint, test
labels: backend, ci
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—CI pipeline: install, lint, test—and should close gaps between what stakeholders expect and what the service actually guarantees. Document operational signals (health, metrics, logs) so on-call staff can diagnose incidents without tribal knowledge. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** CI pipeline: install, lint, test

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *CI pipeline: install, lint, test*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *CI pipeline: install, lint, test* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Unit tests: pure helpers and validators
labels: backend, testing
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Unit tests: pure helpers and validators—and should close gaps between what stakeholders expect and what the service actually guarantees. Clarify trust boundaries between anonymous clients, authenticated partners, administrators, and internal workers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Unit tests: pure helpers and validators

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Unit tests: pure helpers and validators*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Unit tests: pure helpers and validators* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Supertest integration tests for HTTP API
labels: backend, testing
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Supertest integration tests for HTTP API—and should close gaps between what stakeholders expect and what the service actually guarantees. Define how the service behaves when dependencies are degraded (database, Stellar RPC, background workers) and how clients should interpret errors. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Supertest integration tests for HTTP API

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Supertest integration tests for HTTP API*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Supertest integration tests for HTTP API* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Config: multi-network contract addresses (testnet/mainnet)
labels: backend, config, stellar
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Config: multi-network contract addresses (testnet/mainnet)—and should close gaps between what stakeholders expect and what the service actually guarantees. Document operational signals (health, metrics, logs) so on-call staff can diagnose incidents without tribal knowledge. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Config: multi-network contract addresses (testnet/mainnet)

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Config: multi-network contract addresses (testnet/mainnet)*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Config: multi-network contract addresses (testnet/mainnet)* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Task
title: BigInt-safe amount handling end-to-end
labels: backend, safety
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—BigInt-safe amount handling end-to-end—and should close gaps between what stakeholders expect and what the service actually guarantees. Ensure amounts, identities, and stream states crossing the chain/API boundary stay unambiguous for integrators and finance reviewers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** BigInt-safe amount handling end-to-end

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *BigInt-safe amount handling end-to-end*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *BigInt-safe amount handling end-to-end* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Decimal string serialization policy for JSON
labels: backend, api
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Decimal string serialization policy for JSON—and should close gaps between what stakeholders expect and what the service actually guarantees. Ensure amounts, identities, and stream states crossing the chain/API boundary stay unambiguous for integrators and finance reviewers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Decimal string serialization policy for JSON

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Decimal string serialization policy for JSON*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Decimal string serialization policy for JSON* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Admin routes: protected operations (pause flags, reindex)
labels: backend, admin, security
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Admin routes: protected operations (pause flags, reindex)—and should close gaps between what stakeholders expect and what the service actually guarantees. Clarify trust boundaries between anonymous clients, authenticated partners, administrators, and internal workers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Admin routes: protected operations (pause flags, reindex)

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Admin routes: protected operations (pause flags, reindex)*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Admin routes: protected operations (pause flags, reindex)* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Metrics: Prometheus `/metrics` endpoint
labels: backend, observability
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Metrics: Prometheus `/metrics` endpoint—and should close gaps between what stakeholders expect and what the service actually guarantees. Ensure amounts, identities, and stream states crossing the chain/API boundary stay unambiguous for integrators and finance reviewers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Metrics: Prometheus `/metrics` endpoint

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Metrics: Prometheus `/metrics` endpoint*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Metrics: Prometheus `/metrics` endpoint* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Task
title: Distributed tracing hooks (OpenTelemetry optional)
labels: backend, observability
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Distributed tracing hooks (OpenTelemetry optional)—and should close gaps between what stakeholders expect and what the service actually guarantees. Ensure amounts, identities, and stream states crossing the chain/API boundary stay unambiguous for integrators and finance reviewers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Distributed tracing hooks (OpenTelemetry optional)

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Distributed tracing hooks (OpenTelemetry optional)*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Distributed tracing hooks (OpenTelemetry optional)* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Background job queue for long-running sync tasks
labels: backend, worker, reliability
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Background job queue for long-running sync tasks—and should close gaps between what stakeholders expect and what the service actually guarantees. Address abuse scenarios: oversized payloads, excessive request rates, and duplicate submissions, with predictable client-visible outcomes. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Background job queue for long-running sync tasks

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Background job queue for long-running sync tasks*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Background job queue for long-running sync tasks* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Retry policy for failed webhook deliveries
labels: backend, integrations, reliability
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Retry policy for failed webhook deliveries—and should close gaps between what stakeholders expect and what the service actually guarantees. Ensure amounts, identities, and stream states crossing the chain/API boundary stay unambiguous for integrators and finance reviewers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Retry policy for failed webhook deliveries

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Retry policy for failed webhook deliveries*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Retry policy for failed webhook deliveries* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Dead-letter queue inspection API (admin-only)
labels: backend, admin, integrations
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Dead-letter queue inspection API (admin-only)—and should close gaps between what stakeholders expect and what the service actually guarantees. Ensure amounts, identities, and stream states crossing the chain/API boundary stay unambiguous for integrators and finance reviewers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Dead-letter queue inspection API (admin-only)

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Dead-letter queue inspection API (admin-only)*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Dead-letter queue inspection API (admin-only)* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Task
title: Stream status mapping: chain → API enums
labels: backend, indexing, api
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Stream status mapping: chain → API enums—and should close gaps between what stakeholders expect and what the service actually guarantees. Ensure amounts, identities, and stream states crossing the chain/API boundary stay unambiguous for integrators and finance reviewers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Stream status mapping: chain → API enums

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Stream status mapping: chain → API enums*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Stream status mapping: chain → API enums* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: API versioning: `/v1` namespace and deprecation policy
labels: backend, api
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—API versioning: `/v1` namespace and deprecation policy—and should close gaps between what stakeholders expect and what the service actually guarantees. Clarify trust boundaries between anonymous clients, authenticated partners, administrators, and internal workers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** API versioning: `/v1` namespace and deprecation policy

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *API versioning: `/v1` namespace and deprecation policy*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *API versioning: `/v1` namespace and deprecation policy* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Pagination metadata: totals vs cursors
labels: backend, api
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Pagination metadata: totals vs cursors—and should close gaps between what stakeholders expect and what the service actually guarantees. Clarify trust boundaries between anonymous clients, authenticated partners, administrators, and internal workers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Pagination metadata: totals vs cursors

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Pagination metadata: totals vs cursors*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Pagination metadata: totals vs cursors* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Bulk fetch: POST /api/streams:lookup by IDs
labels: backend, api
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Bulk fetch: POST /api/streams:lookup by IDs—and should close gaps between what stakeholders expect and what the service actually guarantees. Ensure amounts, identities, and stream states crossing the chain/API boundary stay unambiguous for integrators and finance reviewers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Bulk fetch: POST /api/streams:lookup by IDs

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Bulk fetch: POST /api/streams:lookup by IDs*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Bulk fetch: POST /api/streams:lookup by IDs* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Task
title: Caching layer for hot reads (Redis)
labels: backend, performance
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Caching layer for hot reads (Redis)—and should close gaps between what stakeholders expect and what the service actually guarantees. Address abuse scenarios: oversized payloads, excessive request rates, and duplicate submissions, with predictable client-visible outcomes. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Caching layer for hot reads (Redis)

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Caching layer for hot reads (Redis)*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Caching layer for hot reads (Redis)* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Websocket channel for stream updates (optional)
labels: backend, realtime, product
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Websocket channel for stream updates (optional)—and should close gaps between what stakeholders expect and what the service actually guarantees. Address abuse scenarios: oversized payloads, excessive request rates, and duplicate submissions, with predictable client-visible outcomes. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Websocket channel for stream updates (optional)

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Websocket channel for stream updates (optional)*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Websocket channel for stream updates (optional)* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Staging deployment checklist parity with prod
labels: backend, ops
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Staging deployment checklist parity with prod—and should close gaps between what stakeholders expect and what the service actually guarantees. Define how the service behaves when dependencies are degraded (database, Stellar RPC, background workers) and how clients should interpret errors. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Staging deployment checklist parity with prod

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Staging deployment checklist parity with prod*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Staging deployment checklist parity with prod* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Secrets management: no secrets in repo
labels: backend, security, ops
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Secrets management: no secrets in repo—and should close gaps between what stakeholders expect and what the service actually guarantees. Address abuse scenarios: oversized payloads, excessive request rates, and duplicate submissions, with predictable client-visible outcomes. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Secrets management: no secrets in repo

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Secrets management: no secrets in repo*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Secrets management: no secrets in repo* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Task
title: Database backups and restore runbook
labels: backend, ops, database
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Database backups and restore runbook—and should close gaps between what stakeholders expect and what the service actually guarantees. Clarify trust boundaries between anonymous clients, authenticated partners, administrators, and internal workers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Database backups and restore runbook

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Database backups and restore runbook*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Database backups and restore runbook* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Load testing harness (k6) for critical endpoints
labels: backend, performance, testing
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Load testing harness (k6) for critical endpoints—and should close gaps between what stakeholders expect and what the service actually guarantees. Ensure amounts, identities, and stream states crossing the chain/API boundary stay unambiguous for integrators and finance reviewers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Load testing harness (k6) for critical endpoints

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Load testing harness (k6) for critical endpoints*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Load testing harness (k6) for critical endpoints* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Incident runbook: indexer stalled
labels: backend, ops, indexing
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Incident runbook: indexer stalled—and should close gaps between what stakeholders expect and what the service actually guarantees. Ensure amounts, identities, and stream states crossing the chain/API boundary stay unambiguous for integrators and finance reviewers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Incident runbook: indexer stalled

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Incident runbook: indexer stalled*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Incident runbook: indexer stalled* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Incident runbook: RPC provider outage
labels: backend, ops, stellar
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Incident runbook: RPC provider outage—and should close gaps between what stakeholders expect and what the service actually guarantees. Clarify trust boundaries between anonymous clients, authenticated partners, administrators, and internal workers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Incident runbook: RPC provider outage

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Incident runbook: RPC provider outage*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Incident runbook: RPC provider outage* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Task
title: PII policy: what we store and retention
labels: backend, compliance
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—PII policy: what we store and retention—and should close gaps between what stakeholders expect and what the service actually guarantees. Clarify trust boundaries between anonymous clients, authenticated partners, administrators, and internal workers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** PII policy: what we store and retention

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *PII policy: what we store and retention*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *PII policy: what we store and retention* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Audit log table for sensitive actions
labels: backend, security, database
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Audit log table for sensitive actions—and should close gaps between what stakeholders expect and what the service actually guarantees. Document operational signals (health, metrics, logs) so on-call staff can diagnose incidents without tribal knowledge. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Audit log table for sensitive actions

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Audit log table for sensitive actions*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Audit log table for sensitive actions* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Route tests: negative cases (404, 400, 401)
labels: backend, testing
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Route tests: negative cases (404, 400, 401)—and should close gaps between what stakeholders expect and what the service actually guarantees. Address abuse scenarios: oversized payloads, excessive request rates, and duplicate submissions, with predictable client-visible outcomes. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Route tests: negative cases (404, 400, 401)

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Route tests: negative cases (404, 400, 401)*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Route tests: negative cases (404, 400, 401)* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Feature
title: Consistent JSON envelope for success responses
labels: backend, api, ux
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Consistent JSON envelope for success responses—and should close gaps between what stakeholders expect and what the service actually guarantees. Clarify trust boundaries between anonymous clients, authenticated partners, administrators, and internal workers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Consistent JSON envelope for success responses

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Consistent JSON envelope for success responses*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Consistent JSON envelope for success responses* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours

++++++

---
type: Task
title: Developer README: local setup with Stellar testnet
labels: backend, docs, dx
assignees: ''
---

## Description

### Summary

Within the Fluxora HTTP and indexing services, this work clarifies predictable behavior for a single responsibility area. The Fluxora backend must present operator-grade reliability: predictable HTTP semantics, durable views of chain-derived data where required, and explicit failure behavior when the world outside the process is messy. This issue is scoped by its title—Developer README: local setup with Stellar testnet—and should close gaps between what stakeholders expect and what the service actually guarantees. Ensure amounts, identities, and stream states crossing the chain/API boundary stay unambiguous for integrators and finance reviewers. Deliver verification appropriate to risk (tests, staging drills, or written runbooks). Anything intentionally deferred should be recorded with follow-up tracking.

**Issue caption:** Developer README: local setup with Stellar testnet

### Domain context

The Fluxora backend is the off-chain companion to the streaming contract: it should present a trustworthy,
operator-grade HTTP surface for discovery and automation, persist durable views of chain-derived state where required,
and fail safely when dependencies (database, Stellar RPC, workers) are unhealthy. Amounts and identities crossing the
boundary from chain to API must remain unambiguous for clients and auditors.

### Work to complete

1. Define the **service-level outcomes** for *Developer README: local setup with Stellar testnet*, treating the **Summary** above as the authoritative scope statement.
2. Identify trust boundaries: public internet clients, authenticated partners, administrators, and internal workers; state what each may and may not do.
3. List failure modes (invalid input, dependency outage, partial data, duplicate delivery) and the expected client-visible behavior for each.
4. Describe how operators will observe health and diagnose incidents for this area without relying on tribal knowledge.

### Definition of done

- Evidence shows *Developer README: local setup with Stellar testnet* behaves as specified under normal load and representative failure conditions.
- Automated tests or monitored checks cover regressions for the critical paths implied by this issue.
- The change set documents verification steps and calls out any intentional non-goals or follow-up work.

### Constraints for contributors

- Describe **outcomes**, **invariants**, and **evidence**, not a single “right” internal design unless the issue title already names a concrete subsystem.
- Prefer **observable** guarantees: state transitions, balances, authorization failures, emitted events, error classifications, and documentation that integrators rely on.
- If something cannot be tested automatically, capture the gap as **audit notes** with explicit rationale and residual risk.

## Requirements and context

- Must be **secure**, **tested**, and **documented** (OpenAPI where applicable).
- Should be **efficient**, **observable**, and **easy to review** for operators.

## Suggested execution

1. Fork the repo and create a branch:
   ```bash
   git checkout -b feature/fluxora-backend
   ```
2. Implement changes
   - **Service code:** `Fluxora-Backend/src/**`
   - **Tests:** `Fluxora-Backend/tests/**` and colocated `*.test.ts` as adopted
   - **Documentation:** inline README sections (no new markdown file unless explicitly requested)
   - Validate assumptions (auth, idempotency, Stellar RPC semantics)
3. **Test and commit**
   - Run `npm test` / `pnpm test` (match package manager)
   - Cover edge cases (validation, pagination, failure modes)
   - Include **test output** + **operational notes** in the PR

### Example commit message

```
feat(api): fluxora backend work
```

## Guidelines

- Aim for **≥95%** coverage on new/changed backend modules (unit + integration).
- **Clear API behavior** documented via OpenAPI or route comments
- **Timeframe:** 96 hours
