# Console output audit

Issue #1250 asked for an inventory of the 23 `console.log` call sites in
`src/`, a level mapping, correlation coverage, PII review, and an enforcement
rule. This document records the decision for every site.

## Decision summary

Twenty-two calls belong to `src/scripts/backup-retention.ts`. That file is a
standalone operator CLI, not a request or background-job lifecycle managed by
the application logger. Its terminal output is intentionally human-readable,
and the command can run directly before application logging is initialized.
Those calls remain as a documented, lint-scoped exception.

The remaining call is the built-in tracer's `console.log` branch. It was part
of application observability and is now routed through `src/lib/logger.ts` at
the same info level. The adjacent error branch was converted at the same time
so the complete tracer path uses one structured sink.

## Site inventory

| File | Line group | Original level | Decision | Reason |
| --- | ---: | --- | --- | --- |
| `src/tracing/builtin.ts` | `logEvent` non-error branch | info | converted | Application tracing event; must carry correlation and sanitizer output |
| `src/tracing/builtin.ts` | `logEvent` error branch | error | converted | Same application tracing path; keep error severity and stderr behavior through logger |
| `src/scripts/backup-retention.ts` | bucket validation | info | exempt | Standalone CLI progress output |
| `src/scripts/backup-retention.ts` | object listing start | info | exempt | Standalone CLI progress output |
| `src/scripts/backup-retention.ts` | object count | info | exempt | Standalone CLI progress output |
| `src/scripts/backup-retention.ts` | empty result | info | exempt | Standalone CLI completion output |
| `src/scripts/backup-retention.ts` | classification heading | info | exempt | Standalone CLI report heading |
| `src/scripts/backup-retention.ts` | daily count | info | exempt | Standalone CLI report detail |
| `src/scripts/backup-retention.ts` | weekly count | info | exempt | Standalone CLI report detail |
| `src/scripts/backup-retention.ts` | monthly count | info | exempt | Standalone CLI report detail |
| `src/scripts/backup-retention.ts` | expired count | info | exempt | Standalone CLI report detail |
| `src/scripts/backup-retention.ts` | retention heading | info | exempt | Standalone CLI report heading |
| `src/scripts/backup-retention.ts` | retained count | info | exempt | Standalone CLI report detail |
| `src/scripts/backup-retention.ts` | delete count | info | exempt | Standalone CLI report detail |
| `src/scripts/backup-retention.ts` | storage recovery | info | exempt | Standalone CLI report detail |
| `src/scripts/backup-retention.ts` | already compliant | info | exempt | Standalone CLI completion output |
| `src/scripts/backup-retention.ts` | deletion heading | info | exempt | Standalone CLI report heading |
| `src/scripts/backup-retention.ts` | object detail | info | exempt | Standalone CLI report detail |
| `src/scripts/backup-retention.ts` | overflow detail | info | exempt | Standalone CLI report detail |
| `src/scripts/backup-retention.ts` | dry-run decision | info | exempt | Standalone CLI decision output |
| `src/scripts/backup-retention.ts` | deletion start | info | exempt | Standalone CLI progress output |
| `src/scripts/backup-retention.ts` | deletion success | info | exempt | Standalone CLI completion output |
| `src/scripts/backup-retention.ts` | CLI startup | info | exempt | Standalone CLI entrypoint |
| `src/scripts/backup-retention.ts` | CLI completion | info | exempt | Standalone CLI entrypoint |

The inventory intentionally records the exact message role rather than
rewriting the message text. The implementation leaves every exempt message
unchanged, preserving operator scripts and snapshots that consume the CLI
output.

## Level mapping

The tracer's non-error branch remains `info`; it is not downgraded to debug
because the existing configuration selects `info` or `debug` as a runtime
policy and the branch was previously emitted as a normal informational line.
The tracer's error branch remains `error`. The backup CLI keeps its existing
`[INFO]` prefixes and its existing error calls, because the issue explicitly
requires message content to remain unchanged for converted sites and the CLI
is the justified exception.

`logger.info` and `logger.error` both accept an optional correlation id and
fall back to the `AsyncLocalStorage` correlation context. The tracer now sends
its event attributes as structured metadata, so the logger can redact sensitive
keys and values before writing JSON. The route/lifecycle test proves that a
tracer line created inside a correlation context contains that identifier.

## PII review

The tracer metadata includes `userId`, trace identifiers, tags, and event
attributes. Before this change the direct `console` calls serialized those
attributes without passing through the logger's `sanitize` and
`redactKeysInString` steps. That was the concrete privacy exposure found in
the audit. The conversion closes it without changing the event message or
severity.

The backup CLI logs bucket names, object-key names, counts, sizes, and deletion
errors. These are operational metadata rather than request bodies, account
addresses, or database rows, but bucket/key names can still be sensitive to an
operator. They remain a terminal-only exception by design and are not emitted
from request handlers. The CLI's existing `console.error` paths are likewise
kept in that explicit exception so its human-readable failure output remains
unchanged.

The address validator's existing `console.warn` calls are not part of the 23
`console.log` inventory. The enforcement rule allows `warn` and `error` while
requiring all `console.log` output in application source to go through the
structured logger or the documented CLI exception. Those warnings already
avoid raw address values and report only address length, network, and a
sanitized error message.

## Enforcement

The flat ESLint configuration applies `no-console` to TypeScript application
source and permits only `console.warn` and `console.error` for legacy warning
paths. `src/scripts/backup-retention.ts` has a narrow file-level override with
the rationale documented above. Tests are exempt because they intentionally
spy on process output and console methods when verifying logging behavior.

This scope is repository-wide for `src/**/*.ts`; it is not limited to one
feature directory. A future CLI exception must be added explicitly and must
include a reason in this audit or its successor. New request/job code cannot
silently add raw informational output.

## Verification checklist

- [x] All 23 `console.log` sites are listed and either converted or exempted.
- [x] The tracer conversion preserves info/error level mapping.
- [x] Tracer logs now inherit the active correlation identifier.
- [x] Tracer metadata now passes through the existing PII sanitizer.
- [x] The standalone backup CLI exception is narrow, commented, and lint-scoped.
- [x] Test-only console spies remain available for logging tests.
- [x] No log message text was rewritten as part of the conversion.

## Operational runbook

### Finding a log line from a request

1. Read the `x-correlation-id` response header from the client request.
2. Search the structured log stream for the same `correlationId` field.
3. Restrict by `message` or `level` only after the correlation filter is
   applied; message text is descriptive and is not a unique request key.
4. If tracing is enabled, use the same identifier to find the corresponding
   request span and its child database or external-service events.

The correlation ID is generated or validated by middleware before the request
body is parsed. This ordering means rejected JSON, authentication failures,
and other early errors still have an identifier that can be used to join logs.
The tracer logger obtains the value from the same asynchronous context, so the
conversion does not require every internal callback to thread a new argument.

### Reading severity

`info` records describe expected progress or successful lifecycle transitions.
They are suitable for normal operational dashboards and should not page by
themselves. `warn` records describe degraded behavior that remains recoverable,
such as a temporary RPC failure or a rejected optional correlation header.
`error` records describe a failed operation or a path that needs investigation.
The backup CLI retains its textual prefixes for terminal users and is not a
structured service log stream.

The tracer's `logLevel` setting controls whether its configured event branch is
enabled. The logger conversion deliberately does not infer a new severity from
the event name: the existing branch decision remains the source of truth. This
avoids a behavior change where an operator's `info` setting silently becomes a
different filtering policy after conversion.

### PII handling

Structured logging is a control boundary, not merely a serialization format.
The canonical logger performs both key-based and string-based redaction before
writing. Callers should still avoid placing raw secrets in metadata because
redaction is defense in depth rather than a license to log credentials.

The following values must never be added to a new log metadata object:

* authorization headers, cookies, session tokens, and refresh tokens;
* full request or response bodies when they contain user-provided fields;
* private keys, signing material, or seed phrases;
* complete database rows when a small identifier or count is sufficient;
* unbounded external error objects without sanitization;
* raw Stellar account addresses when a length, hash, or internal identifier is
  enough for diagnosis.

Trace and span IDs are designed for correlation and are not authentication
credentials. User identifiers can still be personal data, so their presence in
metadata should be justified by the diagnostic need and retained only for the
configured log lifetime.

The converted tracer path sends event attributes through the logger. That
means fields such as `userId`, tags, and error details now receive the same
sanitization as application logs. The conversion does not add any new PII; it
reduces the number of paths that could emit it without the sanitizer.

### CLI exception handling

The backup-retention command is intentionally different from a request handler.
It has no Express request, no correlation middleware, and no long-lived
application logger context when invoked directly with `tsx` or `node`. Its
output is consumed by an operator in a terminal and describes a multi-step
retention report. The exception is therefore limited to one file.

The exception must not expand to a shared script utility. If a future script is
called by an HTTP route or a queue worker, it must import the canonical logger
and accept or recover the current correlation context. A script that needs
machine-readable output should write a documented JSON report rather than
copying the CLI exception.

The CLI does not print request payloads or database rows. It prints bucket and
object-key metadata, counts, byte sizes, and deletion errors. Operators should
run it with a shell environment whose stdout/stderr retention is controlled
like any other operational log sink. The issue audit records that trade-off so
the exception remains visible during future security reviews.

### Code review checklist

Reviewers should use this checklist for future logging changes:

1. Is the call in request, job, indexer, websocket, or CLI code?
2. If it is request/job code, does it use `src/lib/logger.ts`?
3. Is the severity the same as the original behavior, and is it appropriate?
4. Does the call run inside an async correlation context?
5. If it accepts an explicit correlation ID, is that ID validated upstream?
6. Are metadata keys bounded and useful for diagnosis?
7. Could any metadata contain a credential, address, request body, or row?
8. Does the call preserve the message text required by the owning issue?
9. If it is a CLI exception, is the file-level exception narrow and commented?
10. Is there a test proving the relevant output and correlation behavior?

The checklist is intentionally repetitive. Logging changes are easy to review
as text and easy to miss as a privacy or observability regression when buried
inside a larger feature diff.

### Test strategy

The correlation test uses `AsyncLocalStorage` directly to model the context
installed by request middleware. It spies on `process.stdout.write`, which is
the logger's structured output boundary, and parses the resulting JSON record.
This checks the behavior that matters to a log shipper rather than coupling
the test to an implementation-specific `console.log` call.

The existing tracer tests continue to exercise disabled logging, configured
levels, span lifecycle, event capture, and error handling. The new assertion is
small and focused: it proves that a normal span-start event is emitted at info
level with the active correlation ID and the original tracing message.

The backup-retention tests continue to spy on terminal output because that is
the contract of the deliberate CLI exception. Their output expectations are
not changed by this PR. A future migration of that command to structured logs
would need to update those tests and remove the file-level exception together.

### Rollout and monitoring

The conversion is behavior-compatible for the tracer's event name and level,
but its output now follows the canonical logger's JSON shape. Before rollout,
confirm that the log collector accepts `correlationId`, `level`, `message`, and
the existing trace metadata. During rollout, compare event volume and error
counts by level rather than comparing raw line prefixes.

Recommended post-deploy checks are:

* issue one request with a known valid correlation ID and confirm it appears in
  both the response header and a tracer log line;
* issue a request without a correlation ID and confirm middleware generates one;
* send an invalid correlation header and confirm its warning does not include
  the raw untrusted value;
* trigger a span error and confirm the record is written at error severity;
* run backup retention in dry-run mode and confirm terminal messages remain
  unchanged;
* verify that no new `console.log` appears under `src` outside the documented
  CLI exception.

A basic source audit can be repeated with:

```sh
rg -n 'console\\.log' src --glob '*.ts'
```

The expected result after this PR is 22 entries, all in
`src/scripts/backup-retention.ts`. The separate `console.warn` and
`console.error` paths are intentionally covered by the rule's documented
severity allowance and are outside the issue's 23-call `console.log` count.

### Why the rule is scoped to source

Tests frequently need to observe a process boundary. A test that spies on
`process.stdout.write`, `console.warn`, or a CLI's `console.log` is testing the
boundary rather than producing an operational log. Applying `no-console` to
tests would encourage awkward mocks and would obscure the behavior under test.

Production TypeScript source has a different standard: a new informational
line must be structured, sanitized, and correlatable. The flat configuration
therefore applies the rule to source, explicitly turns it off for tests, and
turns it off only for the one standalone CLI file.

### Future exception process

When a new exception is necessary, the contributor must:

1. name the exact file, not a broad directory;
2. explain why the canonical logger is unavailable or inappropriate;
3. state whether the output can contain operational or personal data;
4. add the file to the audit inventory;
5. add a regression test for the intended output;
6. keep the ESLint override adjacent to the source or clearly documented in
   the audit file;
7. revisit the exception when the caller becomes part of the application.

An exception is a maintenance decision that should be easy to remove. It is
not a way to silence a lint rule for convenience.

## Reference examples

### Converting a normal informational line

Before:

```ts
console.log(JSON.stringify({
  level,
  timestamp: new Date().toISOString(),
  message,
  ...attributes,
}));
```

After:

```ts
logger.info(message, undefined, attributes);
```

The after form delegates timestamp creation, level ownership, correlation
lookup, metadata sanitization, output routing, and optional OpenTelemetry
forwarding to one module. It also avoids serializing the same record twice.
The message remains the same, and the selected info level remains the same.

### Converting an error line

Before:

```ts
console.error(JSON.stringify(record));
```

After:

```ts
logger.error(message, undefined, attributes);
```

Error records still use the error sink, but now inherit the canonical error
serialization and metadata handling. If an exception object needs to be added,
callers should use the logger's supported error metadata shape rather than
spreading an arbitrary object into the record.

### Request correlation example

```text
request header:  x-correlation-id: 9f4...
response header: x-correlation-id: 9f4...
log record:      {"level":"info","message":"[tracing] span.start","correlationId":"9f4..."}
```

The header value is accepted only after the correlation middleware validates
its shape and length. An omitted value receives a generated UUID. A malformed
value receives a new UUID and produces a warning that reports only the reason,
not the rejected raw value.

### CLI output example

```text
[INFO] Validating S3 bucket access: backup-bucket
[INFO] Fetching backup objects from s3://backup-bucket/backups/
[INFO] Found 4 backup objects
[DRY-RUN] Skipping actual deletion.
```

This output is useful when an operator runs the command manually. It is not a
request log and has no correlation context to inherit. The file-level lint
exception keeps this interface intact while preventing equivalent output in
application modules.

### Structured fields versus message text

The conversion keeps stable event names in `message` and puts event details in
metadata. Consumers should prefer structured fields for dashboards and alerts:

| Need | Preferred field | Avoid |
| --- | --- | --- |
| Join one request | `correlationId` | parsing a message suffix |
| Filter severity | `level` | `[INFO]` text prefix |
| Find a tracer event | `message` | matching arbitrary JSON text |
| Identify a trace | `traceId` metadata | using user-provided input |
| Measure work | `durationMs` metadata | parsing a sentence |
| Count affected records | bounded count metadata | logging every row |

Structured fields are not a reason to add more data. A field belongs in a log
only when it helps diagnose the operation and is safe for the configured
retention period.

### Correlation failure modes

| Situation | Expected behavior |
| --- | --- |
| Valid UUID header | Reuse it for response and logs |
| Missing header | Generate a fresh correlation ID |
| Blank header | Generate a fresh correlation ID |
| Invalid shape | Generate a fresh correlation ID and warn without raw input |
| Oversized header | Generate a fresh correlation ID and warn without raw input |
| Logger call outside context | Omit the correlation field rather than inventing one |
| Explicit valid logger ID | Use the explicit ID for the record |
| OTel bridge unavailable | Keep primary structured output; swallow bridge failure |

The last two cases are important for background work. A worker may have an
explicit event correlation ID or may legitimately run without one. The logger
must not create a misleading relationship merely to make every record look
complete.

### Review evidence to retain

For a future audit or incident review, retain the following evidence with the
change:

* the before/after `rg` count for raw informational console output;
* the exact ESLint configuration and exception file list;
* a test output line proving correlation propagation;
* a list of fields sent in converted metadata;
* the PII review and any fields intentionally omitted;
* the list of CLI exceptions and their operational owners;
* the full-suite result, including unrelated baseline failures;
* the commit and deployment version where the change became active.

This evidence makes it possible to distinguish a logging conversion from a
message-content change and makes future removal of the CLI exception safer.

### Alerting recommendations

Alerting should be based on stable structured properties, not the old console
format. A service-level dashboard can group by `level`, `message`, and a
bounded operation field. A request investigation should group by
`correlationId`. A trace investigation should join `traceId` and `spanId`.

Avoid alerts on arbitrary user-controlled metadata. Avoid alerting on every
warning from a deliberately fail-open dependency; use a rate or percentage
threshold and pair it with the dependency health metric. Avoid alerting on the
presence of a bucket name or object key because the backup CLI is an operator
workflow and its output is not a service health signal.

### Retention considerations

Correlation IDs, trace IDs, and user identifiers can become personal data when
combined with access logs. The logger's sanitizer protects sensitive fields,
but log retention and access controls remain operational responsibilities.
Teams consuming these records should define a retention period, restrict
access to diagnostic roles, and avoid copying raw logs into issue comments or
chat channels. Redacted records are still potentially linkable records.

The backup CLI exception has a separate retention boundary: terminal output,
CI artifacts, and shell transcripts should be treated as infrastructure logs.
Bucket and object names can reveal topology or business naming, so operators
should avoid publishing command output in public artifacts.

### Migration completion criteria

The logging migration is complete for issue #1250 when all of the following
remain true:

1. `rg -n 'console\\.log' src --glob '*.ts'` reports only the documented backup
   CLI file;
2. no new request, job, websocket, or indexer source file receives a raw
   informational console call;
3. the tracer's info and error branches write through `src/lib/logger.ts`;
4. correlation middleware and logger tests continue to pass;
5. the ESLint exception list contains no broad wildcard for source;
6. the PII audit is updated when metadata fields change;
7. CLI output tests continue to describe the operator-facing contract;
8. a repository-wide lint cleanup can remove, rather than weaken, this rule.

These criteria intentionally include operational and privacy checks in addition
to the source-count check. A zero count without a correlation test could still
leave a structured logger call outside the correct async context, and a green
lint result without an exception review could simply hide an overly broad
disable.

### Audit conclusion

The raw informational output in the application tracer was a real observability
and privacy gap because it bypassed correlation lookup and sanitization. It is
now part of the structured logger path. The remaining raw informational output
belongs to a clearly bounded operator CLI and is visible through a narrow,
commented, file-level lint exception. New source-level `console.log` calls are
now rejected, while existing warning/error diagnostics and test boundary spies
remain intentionally supported.
