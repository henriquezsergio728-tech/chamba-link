import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

// OWASP's argon2id baseline: 19 MiB of memory, 2 passes, 1 lane.
const MEMORY_KIB = 19456;
const PASSES = 2;
const PARALLELISM = 1;
const SALT_BYTES = 16;
const TAG_BYTES = 32;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

const PHC = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

type Params = { memory: number; passes: number; parallelism: number; nonce: Buffer; tagLength: number };

function derive(password: string, params: Params) {
  return new Promise<Buffer>((resolve, reject) => {
    argon2("argon2id", { message: password, ...params }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const b64 = (buf: Buffer) => buf.toString("base64").replace(/=+$/, "");

// Returns a PHC string: $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>, both in base64 without padding.
export async function hashPassword(password: string) {
  const nonce = randomBytes(SALT_BYTES);
  const key = await derive(password, { memory: MEMORY_KIB, passes: PASSES, parallelism: PARALLELISM, nonce, tagLength: TAG_BYTES });
  return `$argon2id$v=19$m=${MEMORY_KIB},t=${PASSES},p=${PARALLELISM}$${b64(nonce)}$${b64(key)}`;
}

// Recomputes the hash with the parameters stored in the string. A malformed string returns false instead of throwing.
export async function verifyPassword(password: string, stored: string) {
  const match = PHC.exec(stored);
  if (!match) return false;
  const [, m, t, p, salt, hash] = match as unknown as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, "base64");
  try {
    const key = await derive(password, {
      memory: Number(m),
      passes: Number(t),
      parallelism: Number(p),
      nonce: Buffer.from(salt, "base64"),
      tagLength: expected.length,
    });
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;

// A hash of a random password, computed on first use, so that a login for an unknown email still runs one verification.
export function dummyHash() {
  dummy ??= hashPassword(randomBytes(32).toString("base64url"));
  return dummy;
}
