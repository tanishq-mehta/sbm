import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = process.env.MAINTENANCE_ENV_FILE || path.join(rootDir, ".env.maintenance");
const supportedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const contentTypesByExtension = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const imageFolder = args.find((arg) => !arg.startsWith("--"));

if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

if (!imageFolder) {
  printUsage();
  process.exit(1);
}

loadEnvFile(envPath);

const baseUrl = trimTrailingSlash(readRequiredEnv("PROD_API_BASE_URL"));
const username = readRequiredEnv("PROD_ADMIN_USERNAME");
const password = readRequiredEnv("PROD_ADMIN_PASSWORD");
const maxBytes = readMaxBytes();

const folderPath = path.resolve(imageFolder);
if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
  fail(`Image folder does not exist: ${folderPath}`);
}

const imageFiles = collectImageFiles(folderPath);
if (!imageFiles.length) {
  fail(`No JPG, PNG, or WebP files found in ${folderPath}`);
}

const { token, user } = await login();
console.error(`Logged in as ${user.username}${user.isAdmin ? " (admin)" : ""}`);
console.error(`${apply ? "Uploading" : "Dry run for"} ${imageFiles.length} image file(s).`);

const result = {
  mode: apply ? "apply" : "dry-run",
  folder: folderPath,
  totalFiles: imageFiles.length,
  matched: 0,
  uploaded: 0,
  unmatched: [],
  duplicateMatches: [],
  duplicateFiles: [],
  tooLarge: [],
  failed: [],
};
const seenBadges = new Map();

for (const filePath of imageFiles) {
  const fileName = path.basename(filePath);
  const extension = path.extname(fileName).toLowerCase();
  const badgeNo = path.basename(fileName, extension).trim();
  const badgeKey = normalizeBadge(badgeNo);

  if (!badgeKey) {
    result.unmatched.push({ fileName, reason: "Filename before extension is blank" });
    continue;
  }

  if (seenBadges.has(badgeKey)) {
    result.duplicateFiles.push({
      badgeNo,
      fileName,
      firstFileName: seenBadges.get(badgeKey),
    });
    continue;
  }
  seenBadges.set(badgeKey, fileName);

  const sizeBytes = fs.statSync(filePath).size;
  if (sizeBytes > maxBytes) {
    result.tooLarge.push({
      badgeNo,
      fileName,
      sizeBytes,
      maxBytes,
    });
    continue;
  }

  const person = await findPersonByBadge(badgeNo);
  if (!person) {
    result.unmatched.push({ badgeNo, fileName, reason: "No exact badge match in app data" });
    continue;
  }
  if (person.duplicate) {
    result.duplicateMatches.push({ badgeNo, fileName, matches: person.matches });
    continue;
  }

  result.matched += 1;
  if (!apply) continue;

  try {
    await uploadPhoto(person.id, filePath, contentTypesByExtension.get(extension));
    result.uploaded += 1;
  } catch (error) {
    result.failed.push({
      badgeNo,
      fileName,
      personId: person.id,
      error: error.message,
    });
  }
}

console.log(JSON.stringify({
  ...result,
  unmatched: result.unmatched.slice(0, 100),
  duplicateMatches: result.duplicateMatches.slice(0, 100),
  duplicateFiles: result.duplicateFiles.slice(0, 100),
  tooLarge: result.tooLarge.slice(0, 100),
  failed: result.failed.slice(0, 100),
}, null, 2));

async function findPersonByBadge(badgeNo) {
  const params = new URLSearchParams({
    field: "Badge no.",
    q: badgeNo,
    limit: "500",
  });
  const payload = await apiRequest("GET", `/api/people?${params.toString()}`);
  const exactMatches = (payload.results || []).filter(
    (person) => normalizeBadge(person.badgeNo) === normalizeBadge(badgeNo)
  );

  if (exactMatches.length === 0) return null;
  if (exactMatches.length > 1) {
    return {
      duplicate: true,
      matches: exactMatches.map((person) => ({
        id: person.id,
        name: person.name,
        badgeNo: person.badgeNo,
      })),
    };
  }
  return exactMatches[0];
}

async function uploadPhoto(personId, filePath, contentType) {
  await apiRequest("POST", `/api/people/${personId}/image`, {
    fileName: path.basename(filePath),
    contentType,
    dataBase64: fs.readFileSync(filePath).toString("base64"),
  });
}

async function login() {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    fail(`Login failed (${response.status}): ${formatPayload(payload)}`);
  }
  if (!payload?.token) {
    fail("Login response did not include a session token.");
  }
  return payload;
}

async function apiRequest(method, endpoint, body) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new Error(`${method} ${endpoint} failed (${response.status}): ${formatPayload(payload)}`);
  }
  return payload;
}

async function readPayload(response) {
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function collectImageFiles(folder) {
  const files = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const entryPath = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectImageFiles(entryPath));
      continue;
    }
    if (entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }));
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`Missing ${filePath}. Create it with PROD_API_BASE_URL, PROD_ADMIN_USERNAME, and PROD_ADMIN_PASSWORD.`);
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function readRequiredEnv(key) {
  const value = process.env[key]?.trim();
  if (!value) fail(`Set ${key} in ${envPath}.`);
  return value;
}

function readMaxBytes() {
  const configured = Number(process.env.PERSON_IMAGE_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : 3 * 1024 * 1024;
}

function normalizeBadge(value) {
  return String(value || "").trim().toUpperCase();
}

function formatPayload(payload) {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function printUsage() {
  console.log(`Usage:
  node scripts/upload_person_images_to_r2.mjs /path/to/image-folder
  node scripts/upload_person_images_to_r2.mjs /path/to/image-folder --apply

Dry-run is the default. Filenames must be exact badge numbers, for example:
  PR0012GA1007.jpg
  EC-107.png

Environment:
  Fill .env.maintenance with:
    PROD_API_BASE_URL=https://sbm-ecru.vercel.app
    PROD_ADMIN_USERNAME=<app username>
    PROD_ADMIN_PASSWORD=<app password>

Optional:
    PERSON_IMAGE_MAX_BYTES=3145728
`);
}
