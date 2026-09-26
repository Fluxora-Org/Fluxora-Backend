/**
 * Data-classification levels shared by the PII policy and the retention
 * manifest.
 *
 * @module pii/classification
 *
 * This enum lives in its own module rather than in `policy.ts` so that
 * `policy.ts` can re-export it while `retention.ts` imports it too, without
 * the two modules forming an import cycle. Every existing
 * `import { DataClassification } from '../pii/policy.js'` keeps working — see
 * the re-export at the bottom of `policy.ts`.
 */

export enum DataClassification {
  /** Freely shareable (health status, API version, docs links). */
  PUBLIC = 'PUBLIC',
  /** Operational data visible to authenticated partners and operators. */
  INTERNAL = 'INTERNAL',
  /** Pseudonymous identifiers that could be correlated to real identities. */
  SENSITIVE = 'SENSITIVE',
  /** Credentials, tokens, or direct PII — never persisted in logs. */
  RESTRICTED = 'RESTRICTED',
}
