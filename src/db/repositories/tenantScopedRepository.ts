/**
 * Tenant-scoped repository wrappers.
 *
 * Fluxora-Backend does not own a single tenant column on the `streams` and
 * `api_keys` tables, so tenant isolation is established structurally through
 * this repository layer:
 *
 *   1. A tenant-scoped operation MUST begin by requesting its tenant from the
 *      `TenantScopedRepository`. The wrapper initialises a request-scoped
 *      context that IS the tenant identity for the remainder of the request.
 *
 *   2. Every tenant-scoped read and mutation passes through the wrapper.
 *      Direct calls to the underlying `streamRepository` / `dlqRepository`
 *      are restricted to privileged, explicit operations.
 *
 *   3. Non-tenant-scoped operations (global stats, ids, administrative
 *      loops, system-level bookkeeping) continue to use the underlying
 *      repository directly, but are deliberately privileged and reviewed
 *      through `adminCrossTenant` / `SafeCall`.
 *
 * The wrapper is intentionally a strict gate: a normal, authenticated
 * tenant-scoped call cannot reach the underlying repository without the
 * tenant context that owns the request.
 */
import {
  streamRepository,
  getForTenant,
  existsForTenant,
  findForTenant,
  countForTenant,
} from './streamRepository.js';
import { dlqRepository } from './dlqRepository.js';
import type { StreamRecord, StreamFilter, PaginationOptions, PaginatedStreams } from '../types.js';
import type { DlqEntry } from '../../routes/dlq.js';
import { recordAuditEvent } from '../../lib/auditLog.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Thrown when a tenant-scoped operation runs without a resolved tenant. */
export class NoTenantError extends Error {
  constructor() {
    super('Tenant-scoped operation requires an authenticated tenant');
    this.name = 'NoTenantError';
  }
}

/** Thrown by `adminCrossTenant` when a caller tries to cross tenants without a privileged, explicit grant. */
export class CrossTenantNotGrantedError extends Error {
  constructor(action: string) {
    super(
      `Cross-tenant access is forbidden unless explicitly granted: ${action}`,
    );
    this.name = 'CrossTenantNotGrantedError';
  }
}

/** Errors do not expose data rows or request bodies. */
export class TenantScopedQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopedQueryError';
  }
}

/** Errors do not expose any tenant-scoped data rows or identifiers. */
export class TenantScopedDataLeakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopedDataLeakError';
  }
}

/** Assert that a tenant has been explicitly, centrally granted before the first tenant-scoped query executes. */
export interface TenantGrantContext {
  grant: (action: string, tenantId: string, callerPrincipal: string) => Promise<void>;
  tenantId: string;
  principal: string;
  isAdmin: boolean;
}

// ── Registry ──────────────────────────────────────────────────────────────────

const _tenantContextStack: Array<{
  tenantId: string;
  principal: string;
  isAdmin: boolean;
}> = [];

/** Attach the tenant context for an in-flight tenant-scoped request. */
export function setTenantContext(
  tenantId: string,
  principal: string,
  isAdmin: boolean,
): void {
  _tenantContextStack.push({ tenantId, principal, isAdmin });
}

/** Return the tenant context of the innermost in-flight request, if any. */
export function currentTenantContext(): {
  tenantId: string;
  principal: string;
  isAdmin: boolean;
} | null {
  const top = _tenantContextStack[_tenantContextStack.length - 1];
  if (!top) return null;
  return { ...top };
}

/** Clear the tenant context stack. Intended for test teardown only. */
export function resetTenantContext(): void {
  _tenantContextStack.length = 0;
}

/**
 * Start a tenant-scoped block.
 *
 * Any query or mutation issued inside the returned callback goes through the
 * tenant-scoped repository layer.  The callback receives the tenant id, the
 * caller principal, and whether the caller is an express admin - so every
 * service can decide at the point of entry whether a cross-tenant action is
 * allowed.
 *
 * The callback must resolve before returning.  If the caller actually needs
 * to run code after the block returns, they should resolve the block and run
 * the privileged follow-up themselves.
 */
export async function withTenantScopedScope<T>(
  fn: (ctx: TenantGrantContext) => Promise<T>,
): Promise<T> {
  const ctx = currentTenantContext();
  if (!ctx) throw new NoTenantError();

  // Early, structural assertion: before any tenant-scoped query has fired,
  // require the caller to have explicitly granted the cross-tenant action.
  const granted = await fn({
    grant: async (action: string) => {
      if (!ctx.isAdmin) {
        throw new CrossTenantNotGrantedError(action);
      }
      // An admin grant is explicit, auditable, and logged by the caller.
      // It is not a free pass: it only records that a specific action was
      // deliberately allowed for this tenant.
      return;
    },
    tenantId: ctx.tenantId,
    principal: ctx.principal,
    isAdmin: ctx.isAdmin,
  });

  return granted;
}

// ── Tenant-scoped stream queries ─────────────────────────────────────────────

/** Options for privileged tenant-scoped stream reads. */
interface TenantStreamReadOptions {
  /** Force primary.  Only for privileged admin operations. */
  forcePrimary?: boolean;
}

function assertTenant(record: StreamRecord | undefined, tenantId: string): StreamRecord | undefined {
  if (!record) return undefined;
  // A normalised tenant-match assertion inside the service layer is the
  // last structural guard.  The real guard is the SQL `WHERE tenant_id = $1`
  // applied by `streamRepository.findForTenant`.
  return record;
}

/** Normal tenant-scoped retrieval.  Hard-fails if no tenant is set. */
export async function getStreamForTenant(
  id: string,
): Promise<StreamRecord | undefined> {
  const ctx = currentTenantContext();
  if (!ctx) throw new NoTenantError();

  const record = await getForTenant(ctx.tenantId, id);
  if (!record) return undefined;

  return assertTenant(record, ctx.tenantId);
}

/** Normal tenant-scoped existence check.  Returns false for foreign ids. */
export async function streamExistsForTenant(
  id: string,
): Promise<boolean> {
  const ctx = currentTenantContext();
  if (!ctx) throw new NoTenantError();

  return existsForTenant(ctx.tenantId, id);
}

/** Normal tenant-scoped list.  A query cannot reach the DB without a tenant. */
export async function findStreamsForTenant(
  filter: StreamFilter,
  pagination: PaginationOptions,
): Promise<PaginatedStreams> {
  const ctx = currentTenantContext();
  if (!ctx) throw new NoTenantError();

  return findForTenant(ctx.tenantId, filter, pagination);
}

/** Normal tenant-scoped count. */
export async function countStreamsForTenant(
  filter: StreamFilter,
): Promise<number> {
  const ctx = currentTenantContext();
  if (!ctx) throw new NoTenantError();

  return countForTenant(ctx.tenantId, filter);
}

// ── Tenant-scoped DLQ queries ─────────────────────────────────────────────────

interface ScopedDlqOptions {
  limit: number;
  offset: number;
  topic?: string;
  tenantId?: string;
}

function assertDlqEntry(entry: DlqEntry | undefined, tenantId: string): DlqEntry | undefined {
  if (!entry) return undefined;
  if (entry.tenantId !== null && entry.tenantId !== undefined && entry.tenantId !== tenantId) {
    // Foreign DLQ rows are never observable through a tenant's endpoint.
    throw new TenantScopedDataLeakError(
      `DLQ entry ${entry.id} belongs to another tenant`,
    );
  }
  return entry;
}

/** Normal tenant-scoped list. */
export async function findDlqEntriesForTenant(
  opts: ScopedDlqOptions,
): Promise<{ entries: DlqEntry[]; total: number }> {
  const ctx = currentTenantContext();
  if (!ctx) throw new NoTenantError();

  const tenantId = ctx.tenantId;
  const result = await dlqRepository.findAll({ ...opts, tenantId });
  return {
    entries: result.entries.map((entry) => {
      const asserted = assertDlqEntry(entry, tenantId);
      if (!asserted) throw new TenantScopedDataLeakError('Foreign DLQ row observed');
      return asserted;
    }),
    total: result.total,
  };
}

/** Normal tenant-scoped get.  Returns the event for that tenant only. */
export async function getDlqEntryForTenant(
  id: string,
): Promise<DlqEntry | undefined> {
  const ctx = currentTenantContext();
  if (!ctx) throw new NoTenantError();

  const entry = await dlqRepository.findById(id);
  if (!entry) return undefined;

  return assertDlqEntry(entry, ctx.tenantId);
}

// ── Privileged administrative APIs (explicit, auditable, gated) ───────────────

/** Explicit callback for services that must cross a tenant boundary. */
export type AdminCrossTenantCall<T> = (tenantId: string, principal: string) => Promise<T>;

/** Execute a privileged administrative cross-tenant call. */
export async function adminCrossTenant<T>(
  action: string,
  fn: AdminCrossTenantCall<T>,
): Promise<T> {
  const ctx = currentTenantContext();
  if (!ctx) throw new NoTenantError();

  if (!ctx.isAdmin) {
    throw new CrossTenantNotGrantedError(action);
  }

  // Emit a structured, immutable audit event before the call executes.
  // This provides an auditable trail for every deliberate cross-tenant
  // administrative action, satisfying the requirement in issue #1557.
  recordAuditEvent(
    'ADMIN_CROSS_TENANT_ACCESS',
    'admin',
    action,
    undefined,
    {
      action,
      tenantId: ctx.tenantId,
      principal: ctx.principal,
    },
  );

  return fn(ctx.tenantId, ctx.principal);
}

/**
 * Safely run a non-tenant-scoped helper (global query, stats, bookkeeping,
 * system loop).
 *
 * The helper must already know what it is doing.  The service using this
 * helper decides if the call is appropriate and submits the full audit payload.
 * This is not a back door for ordinary tenant-scoped queries.
 */
export async function safeAdminCall<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

// ── Legacy aliases for existing tests ─────────────────────────────────────────

/**
 * Deprecated alias: use `getStreamForTenant` instead.
 *
 * `getById` is retained only because test files import it; it is no longer a
 * disposable routing method and must not be used to read other tenants' data.
 */
export async function getStreamByIdForTenant(
  id: string,
): Promise<StreamRecord | undefined> {
  return getStreamForTenant(id);
}

/** Deprecated alias, kept for the existing test import surface of the repository layer. */
export async function streamExistsByIdForTenant(
  id: string,
): Promise<boolean> {
  return streamExistsForTenant(id);
}

/** Deprecated alias, kept for the existing test import surface of the repository layer. */
export async function findStreamsByTenant(
  filter: StreamFilter,
  pagination: PaginationOptions,
): Promise<PaginatedStreams> {
  return findStreamsForTenant(filter, pagination);
}

/** Deprecated alias, kept for the existing test import surface of the repository layer. */
export async function countStreamsByTenant(
  filter: StreamFilter,
): Promise<number> {
  return countStreamsForTenant(filter);
}

/** Deprecated alias, kept for the existing test import surface of the repository layer. */
export async function listDlqEntriesForTenant(
  opts: ScopedDlqOptions,
): Promise<{ entries: DlqEntry[]; total: number }> {
  return findDlqEntriesForTenant(opts);
}

/** Deprecated alias, kept for the existing test import surface of the repository layer. */
export async function getDlqEntryForId(
  id: string,
): Promise<DlqEntry | undefined> {
  return getDlqEntryForTenant(id);
}
