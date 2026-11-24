import {
  createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(String(password), salt, 64, SCRYPT_OPTIONS).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password, storedHash) {
  const [algorithm, salt, expectedHex] = String(storedHash || "").split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
  const actual = scryptSync(String(password), salt, 64, SCRYPT_OPTIONS);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function newSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function newConfirmationCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export const hashConfirmationCode = hashPassword;
export const verifyConfirmationCode = verifyPassword;

let cachedConfirmationKey;
let protectedDataCheck;

function missingProtectedKey() {
  return new Error("Chave criptográfica local ausente para dados persistidos; restauração ou reconciliação necessária.");
}

function confirmationKeyPath() {
  if (process.env.ERMES_CONFIRMATION_KEY_PATH) return resolve(process.env.ERMES_CONFIRMATION_KEY_PATH);
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const databasePath = process.env.ERMES_DB_PATH || resolve(projectRoot, "data", "ermes.sqlite");
  return `${databasePath}.confirmation-key`;
}

// O banco registra a consulta antes de qualquer migração ou operação que use a chave.
// Ler a chave existente não cria um substituto quando há dados dependentes dela.
export function checkConfirmationKeyAvailability(hasProtectedData) {
  protectedDataCheck = hasProtectedData;
  if (process.env.ERMES_CONFIRMATION_CODE_KEY) {
    const configured = Buffer.from(process.env.ERMES_CONFIRMATION_CODE_KEY, "base64url");
    if (configured.length !== 32) throw new Error("ERMES_CONFIRMATION_CODE_KEY deve conter 32 bytes em base64url.");
    return;
  }
  try {
    const existing = readFileSync(confirmationKeyPath());
    if (existing.length !== 32) throw new Error("A chave local dos códigos de confirmação é inválida.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (hasProtectedData()) throw missingProtectedKey();
  }
}

function confirmationEncryptionKey() {
  if (cachedConfirmationKey) return cachedConfirmationKey;
  if (process.env.ERMES_CONFIRMATION_CODE_KEY) {
    const configured = Buffer.from(process.env.ERMES_CONFIRMATION_CODE_KEY, "base64url");
    if (configured.length !== 32) throw new Error("ERMES_CONFIRMATION_CODE_KEY deve conter 32 bytes em base64url.");
    cachedConfirmationKey = configured;
    return cachedConfirmationKey;
  }
  const keyPath = confirmationKeyPath();
  mkdirSync(dirname(keyPath), { recursive: true });
  try {
    cachedConfirmationKey = readFileSync(keyPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!protectedDataCheck || protectedDataCheck()) throw missingProtectedKey();
    const generated = randomBytes(32);
    try {
      writeFileSync(keyPath, generated, { flag: "wx", mode: 0o600 });
      cachedConfirmationKey = generated;
    } catch (writeError) {
      if (writeError.code !== "EEXIST") throw writeError;
      cachedConfirmationKey = readFileSync(keyPath);
    }
  }
  if (cachedConfirmationKey.length !== 32) throw new Error("A chave local dos códigos de confirmação é inválida.");
  chmodSync(keyPath, 0o600);
  return cachedConfirmationKey;
}

function adjustmentSnapshotPayload(adjustment) {
  return JSON.stringify([
    adjustment.id, adjustment.order_id, adjustment.delivery_id, adjustment.company_id,
    adjustment.proposed_by, adjustment.base_version, adjustment.original_items,
    adjustment.proposed_items, adjustment.original_subtotal, adjustment.proposed_subtotal,
    adjustment.original_weight, adjustment.proposed_weight, adjustment.original_freight,
    adjustment.proposed_freight,
  ]);
}

export function sealAdjustmentSnapshot(adjustment) {
  return createHmac("sha256", confirmationEncryptionKey())
    .update("ermes:adjustment-snapshot:v1\0")
    .update(adjustmentSnapshotPayload(adjustment)).digest("hex");
}

export function verifyAdjustmentSnapshot(adjustment, seal) {
  if (typeof seal !== "string" || !/^[0-9a-f]{64}$/.test(seal)) return false;
  const expected = Buffer.from(sealAdjustmentSnapshot(adjustment), "hex");
  return timingSafeEqual(expected, Buffer.from(seal, "hex"));
}

export function encryptConfirmationCode(code) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", confirmationEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(code), "utf8"), cipher.final()]);
  return `aes-256-gcm$${iv.toString("base64url")}$${cipher.getAuthTag().toString("base64url")}$${ciphertext.toString("base64url")}`;
}

export function decryptConfirmationCode(value) {
  const [algorithm, ivValue, tagValue, ciphertextValue] = String(value || "").split("$");
  if (algorithm !== "aes-256-gcm" || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error("Código de confirmação cifrado inválido.");
  }
  const decipher = createDecipheriv("aes-256-gcm", confirmationEncryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final(),
  ]).toString("utf8");
}
