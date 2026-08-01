import crypto from "node:crypto";

const supportedImageTypes = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

export const defaultPersonImageMaxBytes = 3 * 1024 * 1024;

export function imageStorageStatus() {
  const missing = requiredConfigKeys().filter((key) => !process.env[key]?.trim());
  return {
    configured: missing.length === 0,
    missing,
  };
}

export function imageCandidateKeys(badgeNo, preferredKey = "") {
  const keys = [];
  if (preferredKey) keys.push(preferredKey);

  const baseName = safeBadgeFileBase(badgeNo);
  if (baseName) {
    for (const extension of ["jpg", "jpeg", "png", "webp"]) {
      keys.push(imageObjectKey(`${baseName}.${extension}`));
    }
  }

  return [...new Set(keys.filter(Boolean))];
}

export function objectKeyForBadgeImage(badgeNo, { fileName = "", contentType = "" } = {}) {
  const baseName = safeBadgeFileBase(badgeNo);
  if (!baseName) {
    throw statusError(400, "Badge no. is required before a photo can be uploaded.");
  }

  const normalizedType = normalizeImageContentType(contentType, fileName);
  const extension = supportedImageTypes.get(normalizedType);
  return imageObjectKey(`${baseName}.${extension}`);
}

export function normalizeImageContentType(contentType = "", fileName = "") {
  const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (supportedImageTypes.has(normalized)) return normalized;

  const extension = fileExtension(fileName).toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";

  throw statusError(400, "Only JPG, PNG, and WebP photos are supported.");
}

export function detectImageContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return "";

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return "";
}

export async function headImageObject(key) {
  const response = await r2Request("HEAD", key);
  if (response.status === 404) return null;
  if (!response.ok) await throwR2Error(response, "check photo");

  return objectMetadataFromResponse(key, response);
}

export async function getImageObject(key) {
  const response = await r2Request("GET", key);
  if (response.status === 404) return null;
  if (!response.ok) await throwR2Error(response, "read photo");

  const body = Buffer.from(await response.arrayBuffer());
  return {
    ...objectMetadataFromResponse(key, response),
    body,
  };
}

export async function putImageObject(key, buffer, contentType) {
  const response = await r2Request("PUT", key, {
    body: buffer,
    headers: {
      "content-type": contentType,
    },
  });
  if (!response.ok) await throwR2Error(response, "upload photo");

  return {
    key,
    contentType,
    sizeBytes: buffer.length,
    etag: cleanEtag(response.headers.get("etag") || ""),
  };
}

export function personImageMaxBytes() {
  const configured = Number(process.env.PERSON_IMAGE_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : defaultPersonImageMaxBytes;
}

export function imageUploadRequestMaxBytes() {
  return Math.ceil(personImageMaxBytes() * 1.4) + 100_000;
}

export function imageFileNameFromKey(key) {
  return String(key || "").split("/").filter(Boolean).pop() || "";
}

function objectMetadataFromResponse(key, response) {
  return {
    key,
    contentType: response.headers.get("content-type") || "application/octet-stream",
    sizeBytes: Number(response.headers.get("content-length") || 0),
    etag: cleanEtag(response.headers.get("etag") || ""),
    updatedAt: response.headers.get("last-modified") || "",
  };
}

async function r2Request(method, key, { body, headers = {} } = {}) {
  const config = getR2Config();
  const payload = body || Buffer.alloc(0);
  const payloadHash = sha256Hex(payload);
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const shortDate = amzDate.slice(0, 8);
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${encodePathSegment(config.bucket)}/${encodeKeyPath(key)}`;
  const url = `https://${host}${canonicalUri}`;
  const requestHeaders = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...lowercaseHeaders(headers),
  };
  const signedHeaders = Object.keys(requestHeaders).sort();
  const canonicalHeaders = signedHeaders
    .map((header) => `${header}:${String(requestHeaders[header]).trim()}\n`)
    .join("");
  const credentialScope = `${shortDate}/auto/s3/aws4_request`;
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = getSigningKey(config.secretAccessKey, shortDate);
  const signature = hmacHex(signingKey, stringToSign);

  requestHeaders.authorization = [
    "AWS4-HMAC-SHA256",
    `Credential=${config.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders.join(";")}`,
    `Signature=${signature}`,
  ].join(", ");

  return fetch(url, {
    method,
    headers: requestHeaders,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
}

function getR2Config() {
  const status = imageStorageStatus();
  if (!status.configured) {
    throw statusError(503, `Image storage is not configured. Missing: ${status.missing.join(", ")}.`);
  }

  return {
    accountId: process.env.R2_ACCOUNT_ID.trim(),
    accessKeyId: process.env.R2_ACCESS_KEY_ID.trim(),
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY.trim(),
    bucket: process.env.R2_BUCKET.trim(),
  };
}

function imageObjectKey(fileName) {
  const prefix = normalizePrefix(process.env.R2_IMAGE_PREFIX || "");
  return `${prefix}${fileName}`;
}

function safeBadgeFileBase(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

function normalizePrefix(value) {
  const trimmed = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}

function requiredConfigKeys() {
  return ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
}

function fileExtension(fileName) {
  const match = String(fileName || "").match(/\.([A-Za-z0-9]+)$/);
  return match ? match[1] : "";
}

function encodeKeyPath(key) {
  return String(key || "")
    .split("/")
    .map(encodePathSegment)
    .join("/");
}

function encodePathSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function lowercaseHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
}

function formatAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function hmacHex(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

function getSigningKey(secretAccessKey, date) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, date);
  const regionKey = hmac(dateKey, "auto");
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function cleanEtag(value) {
  return String(value || "").replace(/^"|"$/g, "");
}

async function throwR2Error(response, action) {
  const text = await response.text().catch(() => "");
  throw statusError(
    response.status || 500,
    `Could not ${action} in image storage (${response.status}).${text ? ` ${text.slice(0, 300)}` : ""}`
  );
}

function statusError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
