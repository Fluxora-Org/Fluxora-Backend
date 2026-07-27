# Repository conventions — typed Postgres row mapping

## Required pattern

**Never** pass a bare domain interface (e.g. `ReplayCursor`, `StreamRecord`, `VacuumRow`) as the generic type argument to `pg.Pool.query<T>()`, `PoolClient.query<T>()`, or the shared `query()` helper.

`pg` constrains `T` to `QueryResultRow`, which requires an index signature so the driver can return arbitrary column data. Domain interfaces typically do not satisfy that constraint, and `tsc` fails with:

```
error TS2344: Type 'SomeDomainType' does not satisfy the constraint 'QueryResultRow'.
```

### Correct approach

1. Query with a permissive row type: `Record<string, unknown>` (or omit the generic and use pg’s default).
2. Map each row through an explicit `rowToX()` converter into the strongly typed domain interface.

```ts
const result = await client.query<Record<string, unknown>>(sql, params);
return result.rows.map(rowToReplayCursor);
```

### Reference implementations

| Helper | Location |
|--------|----------|
| `rowToRecord` (streams) | `streamRepository.ts` |
| `rowToRecord` (API keys) | `apiKeyRepository.ts` |
| `rowToEntry` / `rowToSuspension` | `dlqRepository.ts` |
| `rowToReplayCursor` / `rowToContractEvent` | `src/indexer/service.ts` |
| `rowToVacuumRow` | `src/metrics/vacuumCollector.ts` |

### Why this matters

- Keeps TypeScript and `pg`’s generics honest.
- Centralizes coercion (BIGINT → number, timestamps → `Date`, etc.) in one place.
- Makes column renames and schema changes easier to audit.

### Audit note (issue #886)

A codebase grep for `query<SomeDomainType>` found one remaining call site in
`src/webhooks/service.ts` (`OutboxRow`). That path uses a local `DbClient`
abstraction whose `query<T>` is **not** constrained to `QueryResultRow`, so it
does not trigger the same `tsc` failure. Prefer `Record<string, unknown>` +
`rowToX()` whenever calling real `pg.Pool` / `PoolClient` APIs.

See also: [docs/database.md](../../../docs/database.md#typed-row-mapping).
