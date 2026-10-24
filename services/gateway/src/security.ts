// Every cryptographic helper the gateway uses, in one place:
//   - passwords:            scrypt (slow on purpose, so stolen hashes are expensive to crack)
//   - API keys + tokens:    long random values, stored only as SHA-256 hashes
//   - upstream credentials: AES-256-GCM encryption at rest (the key lives in a Kubernetes Secret)

import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.js";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

// ---------- Passwords ----------

/** Returns "scrypt$<salt>$<hash>". A fresh random salt per password means equal passwords get different hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [, saltB64, hashB64] = stored.split("$");
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected); // same time whether it's almost right or totally wrong
}

// ---------- API keys, session and invite tokens ----------
// These are 32 random bytes, so (unlike passwords) they can't be guessed; a plain fast SHA-256 is enough
// to make a stolen database useless: you can't turn a hash back into a working key.

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export const randomToken = () => randomBytes(32).toString("base64url");

/** A new gateway API key, e.g. "mgw_3kF9...". The prefix is kept (unhashed) so the UI can show which key is which. */
export function newApiKey() {
  const key = `mgw_${randomToken()}`;
  return { key, prefix: key.slice(0, 12), hash: sha256(key) };
}

// ---------- Upstream credentials: encrypted at rest ----------
// AES-256-GCM gives confidentiality AND integrity: a tampered ciphertext fails to decrypt instead of
// silently producing garbage. Format stored in Postgres: "<iv>.<authTag>.<ciphertext>" (base64 each).

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.encryptionKey, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decrypt(stored: string): string {
  const [iv, tag, data] = stored.split(".").map((s) => Buffer.from(s, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", config.encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
