/**
 * Local, network-free document ID generator.
 *
 * 20 characters: 8 time characters (milliseconds, base62 in ASCII order so IDs
 * sort by creation time) followed by 12 random characters. A same-millisecond
 * counter-free design is enough here because 62^12 random space makes
 * collisions negligible.
 */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const TIME_CHARS = 8;
const RANDOM_CHARS = 12;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoObj = globalThis.crypto as { getRandomValues?: (a: Uint8Array) => Uint8Array } | undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

export function generateAutoDocId(now: number = Date.now()): string {
  let time = Math.max(0, Math.floor(now));
  let prefix = "";
  for (let i = 0; i < TIME_CHARS; i++) {
    prefix = ALPHABET[time % 62] + prefix;
    time = Math.floor(time / 62);
  }
  let suffix = "";
  // Rejection sampling (248 = 62 * 4) keeps the distribution uniform.
  while (suffix.length < RANDOM_CHARS) {
    for (const byte of randomBytes(RANDOM_CHARS * 2)) {
      if (byte < 248 && suffix.length < RANDOM_CHARS) suffix += ALPHABET[byte % 62];
    }
  }
  return prefix + suffix;
}
