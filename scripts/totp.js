// Prints the current 6-digit TOTP code for a base32 secret (test helper).
// Usage: node scripts/totp.js <BASE32_SECRET>
import { totpCode } from '../api/_lib/auth.js';

const secret = process.argv[2];
if (!secret) {
  console.error('Usage: node scripts/totp.js <BASE32_SECRET>');
  process.exit(1);
}
console.log(totpCode(secret));
