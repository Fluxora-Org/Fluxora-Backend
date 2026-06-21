export enum Permission {
  STREAMS_READ = 'streams:read',
  STREAMS_WRITE = 'streams:write',
  ADMIN_READ = 'admin:read',
  ADMIN_PAUSE = 'admin:pause',
  ADMIN_REINDEX = 'admin:reindex',
  ADMIN_API_KEYS = 'admin:api-keys',
  INDEXER_REPLAY = 'indexer:replay',
  DLQ_LIST = 'dlq:list',
  DLQ_READ = 'dlq:read',
  DLQ_REPLAY = 'dlq:replay',
  DLQ_DELETE = 'dlq:delete',
  AUDIT_READ = 'audit:read',
  AUDIT_WRITE = 'audit:write',
}

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  operator: [
    Permission.STREAMS_READ,
    Permission.STREAMS_WRITE,
    Permission.DLQ_LIST,
    Permission.DLQ_READ,
    Permission.DLQ_REPLAY,
    Permission.DLQ_DELETE,
    Permission.AUDIT_READ,
  ],
  viewer: [Permission.STREAMS_READ],
  admin: Object.values(Permission) as Permission[],
};

export const DEFAULT_API_KEY_SCOPES = Object.freeze(
  [...ROLE_PERMISSIONS.admin],
) as readonly Permission[];

const PERMISSION_VALUES = new Set<string>(Object.values(Permission));

export function isKnownPermission(scope: string): scope is Permission {
  return PERMISSION_VALUES.has(scope);
}
