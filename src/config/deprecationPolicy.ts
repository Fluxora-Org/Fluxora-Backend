import type { DeprecatedRoute } from '../middleware/deprecation.js';

/**
 * Sunset-date policy for the deprecation registry.
 *
 * A deprecation without a sunset date is a warning clients have no reason to
 * act on, and it can remain indefinitely because nothing forces anyone to
 * decide when the endpoint goes away. This module turns that expectation into
 * a check that CI (and the test suite) can enforce:
 *
 *   1. every entry must carry a sunset date (missing / blank fails),
 *   2. the date must parse (an unparseable date fails), and
 *   3. the date must not have passed (a passed sunset fails until the endpoint
 *      is removed or the date is deliberately extended).
 *
 * The policy is a pure function of the registry and a `now`, so the check is
 * deterministic and trivially unit-testable.
 */

export type DeprecationViolationCode =
  | 'MISSING_SUNSET'
  | 'INVALID_SUNSET'
  | 'PAST_SUNSET';

export interface DeprecationViolation {
  code: DeprecationViolationCode;
  /** The offending route path. */
  route: string;
  /** The raw configured value when one was present. */
  sunsetDate?: string;
  /** Human-readable explanation for CI output and test failures. */
  message: string;
}

/** Thrown by {@link assertDeprecationSunsetDates} when the registry is invalid. */
export class DeprecationPolicyError extends Error {
  readonly violations: readonly DeprecationViolation[];

  constructor(violations: readonly DeprecationViolation[]) {
    super(
      `Deprecation sunset policy violated: ${violations
        .map((violation) => `${violation.code}(${violation.route})`)
        .join(', ')}`,
    );
    this.name = 'DeprecationPolicyError';
    this.violations = violations;
  }
}

/**
 * Collect every policy violation in `entries`.
 *
 * @param entries - The deprecation registry to check.
 * @param now     - Reference instant; defaults to the current time.
 * @returns Violations in registry order. An empty array means the registry is
 *          valid. The input is never mutated.
 */
export function findDeprecationViolations(
  entries: readonly DeprecatedRoute[],
  now: Date = new Date(),
): DeprecationViolation[] {
  const violations: DeprecationViolation[] = [];
  const nowMs = now.getTime();

  for (const entry of entries) {
    const route = entry.route;
    const raw: unknown = entry.sunsetDate;

    if (typeof raw !== 'string' || raw.trim() === '') {
      violations.push({
        code: 'MISSING_SUNSET',
        route,
        message: `Deprecated route ${route} has no sunset date. Record one in src/config/deprecations.ts.`,
      });
      continue;
    }

    const sunset = new Date(raw);
    if (Number.isNaN(sunset.getTime())) {
      violations.push({
        code: 'INVALID_SUNSET',
        route,
        sunsetDate: raw,
        message: `Deprecated route ${route} has an unparseable sunset date "${raw}".`,
      });
      continue;
    }

    if (sunset.getTime() <= nowMs) {
      violations.push({
        code: 'PAST_SUNSET',
        route,
        sunsetDate: raw,
        message: `Deprecated route ${route} passed its sunset date (${raw}). Remove the endpoint or extend the date deliberately.`,
      });
    }
  }

  return violations;
}

/**
 * Throw a {@link DeprecationPolicyError} unless every entry has a valid,
 * unexpired sunset date.
 */
export function assertDeprecationSunsetDates(
  entries: readonly DeprecatedRoute[],
  now: Date = new Date(),
): void {
  const violations = findDeprecationViolations(entries, now);
  if (violations.length > 0) {
    throw new DeprecationPolicyError(violations);
  }
}
