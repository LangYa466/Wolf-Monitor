import { createHmac, randomBytes } from "crypto";
import { getSetting, setSetting } from "./db";

// Opaque server IDs — hide the auto-increment `seq` behind a format-preserving
// encryption so URLs are short fixed-width digits (e.g. /server/7484127525)
// that can't be enumerated or counted.
//
// We use a balanced Feistel network over the domain [0, 10^WIDTH) with an
// HMAC-SHA256 round function — the same construction FF1 (NIST SP 800-38G) is
// built on, scoped to a fixed decimal width. It's a deterministic bijection, so
// every seq maps to exactly one WIDTH-digit string and back, with no collisions.
//
// The key + tweak live in app_settings; if absent they're generated at random
// on first use (and can be rotated from the admin settings page).

const WIDTH = 10; // 10 decimal digits → up to 9,999,999,999 servers
const RADIX = 100_000; // 10^(WIDTH/2): each Feistel half is 5 digits
const DOMAIN = RADIX * RADIX; // 10^WIDTH
const ROUNDS = 8;

export const ID_KEY_SETTING = "idCipherKey";
export const ID_TWEAK_SETTING = "idCipherTweak";

const g = globalThis as unknown as { __llIdCipher?: { key: Buffer; tweak: Buffer } };

async function cipher(): Promise<{ key: Buffer; tweak: Buffer }> {
  if (g.__llIdCipher) return g.__llIdCipher;

  let keyHex =
    process.env.ID_ENCRYPTION_KEY || (await getSetting<string>(ID_KEY_SETTING)) || "";
  let tweakHex =
    process.env.ID_ENCRYPTION_TWEAK || (await getSetting<string>(ID_TWEAK_SETTING)) || "";

  if (!isHex(keyHex)) {
    keyHex = randomBytes(16).toString("hex");
    await setSetting(ID_KEY_SETTING, keyHex);
  }
  if (!isHex(tweakHex)) {
    tweakHex = randomBytes(8).toString("hex");
    await setSetting(ID_TWEAK_SETTING, tweakHex);
  }

  g.__llIdCipher = { key: Buffer.from(keyHex, "hex"), tweak: Buffer.from(tweakHex, "hex") };
  return g.__llIdCipher;
}

function isHex(s: string): boolean {
  return typeof s === "string" && s.length >= 2 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);
}

// Drop the cached cipher so the next call reloads key/tweak from settings.
// Call after an admin updates them.
export function reloadOpaqueId(): void {
  g.__llIdCipher = undefined;
}

// Read the current key/tweak as hex (generating + persisting them if unset),
// for display in the admin settings page.
export async function getOpaqueIdConfig(): Promise<{ key: string; tweak: string }> {
  const { key, tweak } = await cipher();
  return { key: key.toString("hex"), tweak: tweak.toString("hex") };
}

// Persist new key/tweak (hex) and drop the cache. Pass undefined to leave a
// field unchanged. Throws on malformed hex.
export async function setOpaqueIdConfig(keyHex?: string, tweakHex?: string): Promise<void> {
  if (keyHex !== undefined) {
    if (!isHex(keyHex)) throw new Error("invalid key hex");
    await setSetting(ID_KEY_SETTING, keyHex);
  }
  if (tweakHex !== undefined) {
    if (!isHex(tweakHex)) throw new Error("invalid tweak hex");
    await setSetting(ID_TWEAK_SETTING, tweakHex);
  }
  reloadOpaqueId();
}

// Generate fresh random key + tweak (rotates all opaque ids).
export async function rotateOpaqueId(): Promise<void> {
  await setOpaqueIdConfig(randomBytes(16).toString("hex"), randomBytes(8).toString("hex"));
}

// Feistel round function: 48 bits of HMAC(key, tweak || round || half) mod RADIX.
function F(round: number, half: number, key: Buffer, tweak: Buffer): number {
  const buf = Buffer.alloc(tweak.length + 1 + 4);
  tweak.copy(buf, 0);
  buf[tweak.length] = round & 0xff;
  buf.writeUInt32BE(half >>> 0, tweak.length + 1);
  const d = createHmac("sha256", key).update(buf).digest();
  return d.readUIntBE(0, 6) % RADIX;
}

export async function encodeNodeId(seq: number): Promise<string> {
  const { key, tweak } = await cipher();
  let x = ((Math.trunc(seq) % DOMAIN) + DOMAIN) % DOMAIN;
  let a = Math.floor(x / RADIX);
  let b = x % RADIX;
  for (let i = 0; i < ROUNDS; i++) {
    const t = (a + F(i, b, key, tweak)) % RADIX;
    a = b;
    b = t;
  }
  x = a * RADIX + b;
  return String(x).padStart(WIDTH, "0");
}

export async function decodeNodeId(opaque: string): Promise<number | null> {
  if (!/^\d{1,10}$/.test(opaque)) return null;
  const y = Number(opaque);
  if (!Number.isFinite(y) || y < 0 || y >= DOMAIN) return null;
  const { key, tweak } = await cipher();
  let a = Math.floor(y / RADIX);
  let b = y % RADIX;
  for (let i = ROUNDS - 1; i >= 0; i--) {
    const prevB = a;
    const prevA = (b - F(i, prevB, key, tweak) + RADIX) % RADIX;
    a = prevA;
    b = prevB;
  }
  return a * RADIX + b;
}
