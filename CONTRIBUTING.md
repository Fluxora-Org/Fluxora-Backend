# Contributing to Fluxora Backend

Welcome to the Fluxora Backend repository! This guide provides instructions on how to set up your local development environment, run the required CI gates, and meet test expectations for contributing.

## Local Setup

We use Docker Compose to provide a consistent local environment for development and testing.

1.  **Start the services in the background:**
    ```bash
    pnpm run docker:up
    ```
    This spins up the database and the indexer service. To stop the services, run `pnpm run docker:down`. To view logs, run `pnpm run docker:logs`.

2.  **Run Migrations:**
    Once the database container is up, apply the schema migrations:
    ```bash
    pnpm run docker:migrate
    ```

3.  **Seed the Database:**
    Seed the database with test data:
    ```bash
    pnpm run docker:seed
    ```

4.  **Run Tests inside Docker:**
    To run tests inside the Docker container:
    ```bash
    pnpm run docker:test
    ```

## CI Gates

We have several continuous integration (CI) jobs that every pull request must pass. You can (and should) run these locally before pushing your changes to avoid pipeline failures.

### 1. TypeScript Typecheck
Asserts that there are no type errors in the codebase.
**Command to reproduce locally:**
```bash
pnpm run typecheck
```

### 2. Linting
Enforces code style and formatting rules. The CI pipeline specifically checks changed files.
**Command to reproduce locally:**
```bash
pnpm run lint
```
(To fix auto-fixable issues, you can run `pnpm run format`).

### 3. Testing & Coverage
Runs the test suite, live database integration suites, and SDK drift checks. The pipeline enforces a minimum test coverage.
**Command to reproduce locally:**
```bash
pnpm test
```
To run the exact CI coverage target:
```bash
pnpm test:coverage:ci
```

*Note: The test job also includes SDK and migration checks, which can be run with:*
```bash
pnpm run check:sdk:python
pnpm run check:sdk:ts
pnpm run check:migrations
```

### 4. Security Audit
Checks dependencies for known vulnerabilities.
**Command to reproduce locally:**
```bash
pnpm audit --audit-level=moderate
```

### 5. Docker Build
Verifies that the application Docker image builds successfully.
**Command to reproduce locally:**
```bash
docker build -t indexer:local .
```

### 6. End-to-End (E2E) Tests
Nightly tests running against the live Stellar testnet.
**Command to reproduce locally:**
```bash
pnpm vitest run tests/e2e
```
*(Requires E2E environment variables like `DATABASE_URL`, `HORIZON_URL`, etc., to be set).*

## Migration and Seeding Workflow

When developing features that require database schema changes:

1.  **Create a Migration**: Create a new migration file following our naming policy.
2.  **Apply Migration Locally**: Run `pnpm run docker:migrate` (or `pnpm run migrate` if running locally without docker).
3.  **Update Seeding script (if necessary)**: If the new schema requires initial data or if test scenarios need it, update `scripts/seed-test-data.ts`.
4.  **Run the Seed**: Populate the data using `pnpm run docker:seed`.

The CI pipeline runs the migrations against an ephemeral database before running tests.

## Test Expectations

-   **Unit Tests**: Any new logic must be covered by unit tests.
-   **Integration Tests**: If your change interacts with the database or an external service, you must include integration tests (or update existing ones).
-   **No Broken Tests**: Your change must not break any existing tests.
-   **Coverage**: You must maintain or increase the overall test coverage. The `pnpm test:coverage:ci` command checks if the coverage meets the required threshold.
-   **Local Passing State**: A new contributor should reach a passing local gate set before pushing changes using the commands above.
