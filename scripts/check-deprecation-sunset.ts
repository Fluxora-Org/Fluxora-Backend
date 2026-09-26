#!/usr/bin/env tsx

/**
 * CI guard for the deprecation registry.
 *
 * Fails (non-zero exit) when `src/config/deprecations.ts` contains an entry
 * without a sunset date, with an unparseable one, or with a sunset date that
 * has already passed. A passed date must be dealt with deliberately: remove
 * the endpoint or extend the date — otherwise the warning clients receive is
 * not actionable.
 *
 * Run locally with `pnpm run check:deprecations`.
 */

import process from 'node:process';
import { routeDeprecations } from '../src/config/deprecations.js';
import {
  assertDeprecationSunsetDates,
  DeprecationPolicyError,
} from '../src/config/deprecationPolicy.js';

export function main(now: Date = new Date()): number {
  try {
    assertDeprecationSunsetDates(routeDeprecations, now);
  } catch (error) {
    if (error instanceof DeprecationPolicyError) {
      console.error('Deprecation sunset check failed:');
      for (const violation of error.violations) {
        console.error(`  - [${violation.code}] ${violation.message}`);
      }
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Deprecation sunset check failed: ${message}`);
    return 1;
  }

  const count = routeDeprecations.length;
  console.log(
    `Deprecation sunset check passed: ${count} entr${count === 1 ? 'y' : 'ies'} with a future sunset date.`,
  );
  return 0;
}

process.exitCode = main();
