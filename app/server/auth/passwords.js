import crypto from 'node:crypto';
import { promisify } from 'node:util';

const argon2 = promisify(crypto.argon2);

// OWASP-recommended argon2id baseline is m=19MiB,t=2; we use a stronger local profile.
const PARAMS = { memory: 65536, passes: 3, parallelism: 4, tagLength: 32 };

/** Returns a PHC-format string: $argon2id$v=19$m=..,t=..,p=..$salt$hash */
export async function hashSecret(secret) {
  const nonce = crypto.randomBytes(16);
  const tag = await argon2('argon2id', { message: Buffer.from(secret, 'utf8'), nonce, ...PARAMS });
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${nonce.toString('base64url')}$${tag.toString('base64url')}`;
}

export async function verifySecret(secret, phc) {
  if (typeof secret !== 'string' || typeof phc !== 'string') return false;
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/.exec(phc);
  if (!m) return false;
  const expected = Buffer.from(m[5], 'base64url');
  const tag = await argon2('argon2id', {
    message: Buffer.from(secret, 'utf8'),
    nonce: Buffer.from(m[4], 'base64url'),
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return tag.length === expected.length && crypto.timingSafeEqual(tag, expected);
}
