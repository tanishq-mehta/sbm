import crypto from "node:crypto";
import { loadEnvFile } from "./env.mjs";

loadEnvFile();

const passwordHashPrefix = "pbkdf2_sha256";
const passwordHashIterations = 310_000;
const sessionMaxAgeSeconds = Number(process.env.AUTH_SESSION_SECONDS || 60 * 60 * 8);

let cachedUsersRaw;
let cachedUsers;

export class AuthConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthConfigurationError";
  }
}

export function authenticateUser(username, password) {
  const normalizedUsername = String(username || "").trim();
  if (!normalizedUsername || !password) return null;

  const user = getConfiguredUsers().find(
    (entry) => entry.username.toLowerCase() === normalizedUsername.toLowerCase()
  );
  if (!user || !verifyPassword(password, user.passwordHash)) return null;

  return { username: user.username };
}

export function createSessionToken(username) {
  const now = Math.floor(Date.now() / 1000);
  const payload = encodeBase64Url(
    JSON.stringify({
      sub: username,
      iat: now,
      exp: now + sessionMaxAgeSeconds,
    })
  );
  const signature = sign(payload);
  return `sbm1.${payload}.${signature}`;
}

export function verifySessionToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "sbm1") return null;

  const [, payload, signature] = parts;
  if (!timingSafeEqualText(signature, sign(payload))) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed.sub || Number(parsed.exp) < Math.floor(Date.now() / 1000)) return null;
    const user = getConfiguredUsers().find(
      (entry) => entry.username.toLowerCase() === String(parsed.sub).toLowerCase()
    );
    return user ? { username: user.username } : null;
  } catch {
    return null;
  }
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(String(password), salt, passwordHashIterations, 32, "sha256")
    .toString("hex");
  return `${passwordHashPrefix}$${passwordHashIterations}$${salt}$${hash}`;
}

function verifyPassword(password, passwordHash) {
  const parts = String(passwordHash || "").split("$");
  if (parts.length !== 4 || parts[0] !== passwordHashPrefix) return false;

  const [, iterationsText, salt, expectedHash] = parts;
  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations < 100_000 || !salt || !expectedHash) {
    return false;
  }

  const actualHash = crypto
    .pbkdf2Sync(String(password), salt, iterations, 32, "sha256")
    .toString("hex");
  return timingSafeEqualText(actualHash, expectedHash);
}

function getConfiguredUsers() {
  const raw = process.env.AUTH_USERS_JSON || process.env.AUTH_USERS || "";
  if (raw === cachedUsersRaw && cachedUsers) return cachedUsers;

  if (!raw.trim()) {
    throw new AuthConfigurationError("No allowed auth users configured. Set AUTH_USERS_JSON.");
  }

  const users = parseUsers(raw);
  if (!users.length) {
    throw new AuthConfigurationError("AUTH_USERS_JSON did not contain any valid users.");
  }

  cachedUsersRaw = raw;
  cachedUsers = users;
  return cachedUsers;
}

function parseUsers(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeUser).filter(Boolean);
    }
    return Object.entries(parsed)
      .map(([username, passwordHash]) => normalizeUser({ username, passwordHash }))
      .filter(Boolean);
  }

  return trimmed
    .split(",")
    .map((entry) => {
      const separator = entry.indexOf(":");
      if (separator === -1) return null;
      return normalizeUser({
        username: entry.slice(0, separator),
        passwordHash: entry.slice(separator + 1),
      });
    })
    .filter(Boolean);
}

function normalizeUser(entry) {
  const username = String(entry?.username || "").trim();
  const passwordHash = String(entry?.passwordHash || "").trim();
  if (!username || !passwordHash) return null;
  return { username, passwordHash };
}

function sign(payload) {
  return crypto.createHmac("sha256", getAuthSecret()).update(payload).digest("base64url");
}

function getAuthSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;

  const userMaterial = getConfiguredUsers()
    .map((entry) => `${entry.username}:${entry.passwordHash}`)
    .join("|");
  return crypto.createHash("sha256").update(userMaterial).digest("hex");
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
