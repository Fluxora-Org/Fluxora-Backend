import { generateToken } from '../../src/lib/auth.js';
import { Permission } from '../../src/middleware/auth.js';

export function generateAdminToken(
  address = 'GADMIN0000000000000000000000000000000000000000000000000000',
): string {
  return generateToken({
    address,
    role: 'admin',
    permissions: Object.values(Permission),
  });
}
