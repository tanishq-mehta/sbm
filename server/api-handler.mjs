import {
  checkDatabaseConnection,
  cleanEmailValues,
  cleanPlaceholderTextValues,
  createPerson,
  databaseProvider,
  deletePerson,
  dropdownOptions,
  fields,
  getDataQualitySummary,
  getPerson,
  getPersonImageMetadata,
  getLocationOptions,
  getVerificationSummary,
  importStatusValues,
  initializeDatabase,
  isSbmExportExcludedPerson,
  listVerificationPeople,
  listAuditLogs,
  listAllAuditLogs,
  listElderlyAlerts,
  listAllPeople,
  listDataQualityPeople,
  listPeople,
  mapMajorCentresFromDepartments,
  normalizeDepartmentValues,
  renumberSerialNumbers,
  restorePersonFromAudit,
  runElderlyAlertScan,
  savePersonImageMetadata,
  sbmExportFields,
  searchableFields,
  updatePerson,
} from "./database.mjs";
import { createWorkbookBuffer } from "./xlsx.mjs";
import {
  AuthConfigurationError,
  authenticateUser,
  createSessionToken,
  verifySessionToken,
} from "./auth.mjs";
import {
  detectImageContentType,
  diagnoseImageStorage,
  getImageObject,
  headImageObject,
  imageCandidateKeys,
  imageFileNameFromKey,
  imageStorageStatus,
  imageUploadRequestMaxBytes,
  objectKeyForBadgeImage,
  personImageMaxBytes,
  putImageObject,
} from "./r2-storage.mjs";

let initializationPromise;

export async function handleApiRequest(req, res) {
  try {
    applyCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/health") {
      if (url.searchParams.get("db") === "1") {
        try {
          await ensureDatabaseInitialized();
          await checkDatabaseConnection();
          sendJson(res, 200, {
            ok: true,
            database: databaseProvider,
            connected: true,
          });
        } catch (error) {
          console.error(error);
          sendJson(res, 500, {
            ok: false,
            database: databaseProvider,
            connected: false,
            error: formatSafeError(error),
          });
        }
        return;
      }

      sendJson(res, 200, {
        ok: true,
        database: databaseProvider,
        hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
      });
      return;
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = await readJson(req);
      const user = authenticateUser(body.username, body.password);
      if (user) {
        sendJson(res, 200, {
          token: createSessionToken(user.username),
          user,
        });
      } else {
        sendJson(res, 401, { message: "Invalid username or password." });
      }
      return;
    }

    if (url.pathname === "/api/cron/elderly-alerts" && req.method === "GET") {
      if (!isValidCronRequest(req)) {
        sendJson(res, 401, { message: "Cron authorization required." });
        return;
      }

      await ensureDatabaseInitialized();
      sendJson(res, 200, await runElderlyAlertScan({
        runKey: elderlyAlertMonthlyRunKey(),
        source: "vercel-cron",
      }));
      return;
    }

    const authenticatedUser = url.pathname.startsWith("/api/")
      ? getAuthenticatedUser(req)
      : null;

    if (url.pathname.startsWith("/api/") && !authenticatedUser) {
      sendJson(res, 401, { message: "Authentication required." });
      return;
    }

    if (url.pathname === "/api/session" && req.method === "GET") {
      sendJson(res, 200, { user: authenticatedUser });
      return;
    }

    if (isAdminOnlyMutation(url, req.method)) {
      if (!requireAdmin(res, authenticatedUser, adminOnlyMessage(url, req.method))) {
        return;
      }
    }

    await ensureDatabaseInitialized();

    if (url.pathname === "/api/fields" && req.method === "GET") {
      sendJson(res, 200, { fields, searchableFields, dropdownOptions });
      return;
    }

    if (url.pathname === "/api/location-options" && req.method === "GET") {
      sendJson(res, 200, getLocationOptions({
        state: url.searchParams.get("state") || "",
        district: url.searchParams.get("district") || "",
      }));
      return;
    }

    if (url.pathname === "/api/export/people.xlsx" && req.method === "GET") {
      const people = await listAllPeople();
      const rows = people.map((person) =>
        fields.map((field) => person.data?.[field] || "")
      );
      const workbook = createWorkbookBuffer({
        sheetName: "People",
        headers: fields,
        rows,
      });
      const date = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="sbm-users-${date}.xlsx"`,
        "Content-Length": workbook.length,
        "Cache-Control": "no-store",
      });
      res.end(workbook);
      return;
    }

    if (url.pathname === "/api/export/sbm-pr.xlsx" && req.method === "GET") {
      const people = (await listAllPeople())
        .filter(isPrPerson)
        .filter((person) => !isSbmExportExcludedPerson(person))
        .sort(compareByPrSerialNumber);
      const rows = people.map((person) =>
        sbmExportFields.map((field) => sbmExportCellValue(person, field))
      );
      const workbook = createWorkbookBuffer({
        sheetName: "Data",
        headers: sbmExportFields,
        rows,
      });
      const date = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="sbm-pr-sewadars-${date}.xlsx"`,
        "Content-Length": workbook.length,
        "Cache-Control": "no-store",
      });
      res.end(workbook);
      return;
    }

    if (url.pathname === "/api/export/audits.xlsx" && req.method === "GET") {
      const audits = await listAllAuditLogs();
      const workbook = createWorkbookBuffer({
        sheetName: "Audit History",
        headers: [
          "Audit ID",
          "Action",
          "Changed At",
          "Changed By",
          "Record ID",
          "Name",
          "Badge Number",
          "Field",
          "Old Value",
          "New Value",
        ],
        rows: auditWorkbookRows(audits),
      });
      const date = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="sbm-audit-history-${date}.xlsx"`,
        "Content-Length": workbook.length,
        "Cache-Control": "no-store",
      });
      res.end(workbook);
      return;
    }

    if (url.pathname === "/api/summary" && req.method === "GET") {
      const department = url.searchParams.get("department") || "";
      sendJson(res, 200, await getVerificationSummary({ department }));
      return;
    }

    if (url.pathname === "/api/summary/verification/people" && req.method === "GET") {
      sendJson(res, 200, await listVerificationPeople({
        status: url.searchParams.get("status") || "",
        badgePrefix: url.searchParams.get("badgePrefix") || "",
        department: url.searchParams.get("department") || "",
      }));
      return;
    }

    if (url.pathname === "/api/summary/data-quality" && req.method === "GET") {
      sendJson(res, 200, await getDataQualitySummary({
        onlyNonElderly: isTruthyQueryValue(url.searchParams.get("onlyNonElderly")),
      }));
      return;
    }

    if (url.pathname === "/api/summary/data-quality/people" && req.method === "GET") {
      sendJson(res, 200, await listDataQualityPeople({
        field: url.searchParams.get("field") || "",
        issue: url.searchParams.get("issue") || "",
        group: url.searchParams.get("group") || "",
        onlyNonElderly: isTruthyQueryValue(url.searchParams.get("onlyNonElderly")),
      }));
      return;
    }

    if (url.pathname === "/api/elderly-alerts" && req.method === "GET") {
      sendJson(res, 200, await listElderlyAlerts());
      return;
    }

    if (url.pathname === "/api/admin/renumber-sno" && req.method === "POST") {
      const body = await readJson(req);
      sendJson(res, 200, await renumberSerialNumbers({
        batchSize: body.batchSize,
        dryRun: Boolean(body.dryRun),
        changedBy: authenticatedUser.username,
      }));
      return;
    }

    if (url.pathname === "/api/admin/elderly-alerts/run" && req.method === "POST") {
      const body = await readJson(req);
      sendJson(res, 200, await runElderlyAlertScan({
        asOf: body.asOf,
        source: authenticatedUser.username,
        changedBy: authenticatedUser.username,
      }));
      return;
    }

    if (url.pathname === "/api/admin/normalize-departments" && req.method === "POST") {
      const body = await readJson(req);
      const result = await normalizeDepartmentValues({
        batchSize: body.batchSize,
        changedBy: authenticatedUser.username,
        returnSummary: true,
      });
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/admin/clean-emails" && req.method === "POST") {
      const body = await readJson(req);
      const result = await cleanEmailValues({
        batchSize: body.batchSize,
        dryRun: Boolean(body.dryRun),
        returnSummary: true,
      });
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/admin/clean-placeholder-text" && req.method === "POST") {
      const body = await readJson(req);
      const result = await cleanPlaceholderTextValues({
        batchSize: body.batchSize,
        dryRun: Boolean(body.dryRun),
        returnSummary: true,
      });
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/admin/import-statuses" && req.method === "POST") {
      const body = await readJson(req);
      const result = await importStatusValues(body.rows || [], {
        batchSize: body.batchSize,
        dryRun: Boolean(body.dryRun),
        returnSummary: true,
      });
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/admin/map-major-centres" && req.method === "POST") {
      const body = await readJson(req);
      const result = await mapMajorCentresFromDepartments({
        batchSize: body.batchSize,
        dryRun: Boolean(body.dryRun),
        prOnly: body.prOnly !== false,
        changedBy: authenticatedUser.username,
        returnSummary: true,
      });
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/admin/image-storage-check" && req.method === "GET") {
      if (!requireAdmin(res, authenticatedUser, "Only admin users can check image storage.")) {
        return;
      }
      sendJson(res, 200, await diagnoseImageStorage());
      return;
    }

    if (url.pathname === "/api/audits" && req.method === "GET") {
      const limit = url.searchParams.get("limit") || "500";
      sendJson(res, 200, {
        results: await listAuditLogs({ limit }),
      });
      return;
    }

    const restoreMatch = url.pathname.match(/^\/api\/audits\/(\d+)\/restore$/);
    if (restoreMatch && req.method === "POST") {
      const person = await restorePersonFromAudit(restoreMatch[1], {
        changedBy: authenticatedUser.username,
      });
      if (!person) {
        sendJson(res, 404, { message: "Audit entry not found." });
        return;
      }
      sendJson(res, 200, { person });
      return;
    }

    if (url.pathname === "/api/people" && req.method === "GET") {
      const query = url.searchParams.get("q") || "";
      const field = url.searchParams.get("field") || "All fields";
      const limit = url.searchParams.get("limit") || "200";
      sendJson(res, 200, await listPeople({ query, field, limit }));
      return;
    }

    if (url.pathname === "/api/people" && req.method === "POST") {
      const body = await readJson(req);
      const person = await createPerson(body.data || {}, {
        changedBy: authenticatedUser.username,
      });
      sendJson(res, 201, person);
      return;
    }

    const personImageInfoMatch = url.pathname.match(/^\/api\/people\/(\d+)\/image-info$/);
    if (personImageInfoMatch && req.method === "GET") {
      const person = await getPerson(personImageInfoMatch[1]);
      if (!person) {
        sendJson(res, 404, { message: "Person not found." });
        return;
      }

      sendJson(res, 200, await personImageInfo(person));
      return;
    }

    const personImageMatch = url.pathname.match(/^\/api\/people\/(\d+)\/image$/);
    if (personImageMatch && req.method === "GET") {
      const person = await getPerson(personImageMatch[1]);
      if (!person) {
        sendJson(res, 404, { message: "Person not found." });
        return;
      }

      const located = await locatePersonImage(person);
      if (!located) {
        sendJson(res, 404, { message: "Photo not found." });
        return;
      }

      const image = await getImageObject(located.key);
      if (!image) {
        sendJson(res, 404, { message: "Photo not found." });
        return;
      }

      res.writeHead(200, personImageHeaders(image));
      res.end(image.body);
      return;
    }

    if (personImageMatch && req.method === "POST") {
      const person = await getPerson(personImageMatch[1]);
      if (!person) {
        sendJson(res, 404, { message: "Person not found." });
        return;
      }

      const body = await readJson(req, { maxBytes: imageUploadRequestMaxBytes() });
      const upload = parseImageUpload(body);
      const objectKey = objectKeyForBadgeImage(person.data?.["Badge no."] || person.badgeNo, upload);
      const stored = await putImageObject(objectKey, upload.buffer, upload.contentType);
      const metadata = await savePersonImageMetadata(
        person,
        {
          badgeNo: person.data?.["Badge no."] || person.badgeNo || "",
          objectKey: stored.key,
          contentType: stored.contentType,
          sizeBytes: stored.sizeBytes,
          etag: stored.etag,
        },
        { changedBy: authenticatedUser.username }
      );

      sendJson(res, 200, imageInfoPayload(person, {
        configured: true,
        available: true,
        metadata,
        object: stored,
      }));
      return;
    }

    const personMatch = url.pathname.match(/^\/api\/people\/(\d+)$/);
    if (personMatch && req.method === "GET") {
      const person = await getPerson(personMatch[1]);
      if (!person) {
        sendJson(res, 404, { message: "Person not found." });
        return;
      }
      sendJson(res, 200, person);
      return;
    }

    if (personMatch && req.method === "PUT") {
      const body = await readJson(req);
      const person = await updatePerson(personMatch[1], body.data || {}, {
        changedBy: authenticatedUser.username,
      });
      if (!person) {
        sendJson(res, 404, { message: "Person not found." });
        return;
      }
      sendJson(res, 200, person);
      return;
    }

    if (personMatch && req.method === "DELETE") {
      const person = await deletePerson(personMatch[1], {
        changedBy: authenticatedUser.username,
      });
      if (!person) {
        sendJson(res, 404, { message: "Person not found." });
        return;
      }
      sendJson(res, 200, { deleted: true, person });
      return;
    }

    sendJson(res, 404, { message: "API route not found." });
  } catch (error) {
    console.error(error);
    if (error?.statusCode) {
      sendJson(res, error.statusCode, { message: error.message });
      return;
    }
    const authResponse = authErrorResponse(error);
    if (authResponse) {
      sendJson(res, 500, authResponse);
      return;
    }
    sendJson(res, 500, {
      message: "Unexpected server error.",
      error: formatSafeError(error),
    });
  }
}

function ensureDatabaseInitialized() {
  initializationPromise ||= initializeDatabase().catch((error) => {
    initializationPromise = undefined;
    throw error;
  });
  return initializationPromise;
}

async function personImageInfo(person) {
  const storageStatus = imageStorageStatus();
  if (!storageStatus.configured) {
    return imageInfoPayload(person, {
      configured: false,
      available: false,
      missingConfig: storageStatus.missing,
    });
  }

  const metadata = await getPersonImageMetadata(person.id);
  let object = null;
  let storageError = "";
  try {
    object = await locatePersonImage(person, metadata);
  } catch (error) {
    storageError = formatSafeError(error).message;
  }
  return imageInfoPayload(person, {
    configured: true,
    available: Boolean(object),
    metadata,
    object,
    storageError,
  });
}

async function locatePersonImage(person, metadata = null) {
  const badgeNo = person.data?.["Badge no."] || person.badgeNo || "";
  for (const key of imageCandidateKeys(badgeNo, metadata?.objectKey || "")) {
    const object = await headImageObject(key);
    if (object) return object;
  }
  return null;
}

function imageInfoPayload(person, details = {}) {
  const object = details.object || null;
  const metadata = details.metadata || null;
  const key = object?.key || metadata?.objectKey || "";

  return {
    configured: Boolean(details.configured),
    available: Boolean(details.available),
    missingConfig: details.missingConfig || [],
    storageError: details.storageError || "",
    personId: Number(person.id),
    badgeNo: person.data?.["Badge no."] || person.badgeNo || "",
    fileName: imageFileNameFromKey(key),
    contentType: object?.contentType || metadata?.contentType || "",
    sizeBytes: Number(object?.sizeBytes || metadata?.sizeBytes || 0),
    uploadedBy: metadata?.uploadedBy || "",
    updatedAt: object?.updatedAt || metadata?.updatedAt || "",
    url: details.available ? `/api/people/${person.id}/image` : "",
    maxBytes: personImageMaxBytes(),
  };
}

function parseImageUpload(body) {
  const fileName = String(body?.fileName || "").trim();
  const dataBase64 = String(body?.dataBase64 || "").replace(/^data:[^,]+;base64,/, "");
  if (!dataBase64) throw statusError(400, "Choose a photo before uploading.");

  const buffer = Buffer.from(dataBase64, "base64");
  if (!buffer.length) throw statusError(400, "Uploaded photo is empty.");

  const maxBytes = personImageMaxBytes();
  if (buffer.length > maxBytes) {
    throw statusError(413, `Photo must be ${formatBytes(maxBytes)} or smaller.`);
  }

  const detectedContentType = detectImageContentType(buffer);
  if (!detectedContentType) throw statusError(400, "Only valid JPG, PNG, and WebP photos are supported.");

  return {
    buffer,
    fileName,
    contentType: detectedContentType,
  };
}

function personImageHeaders(image) {
  const fileName = safeHeaderFileName(imageFileNameFromKey(image.key) || "photo");
  const headers = {
    "Content-Type": image.contentType || "application/octet-stream",
    "Content-Disposition": `inline; filename="${fileName}"`,
    "Cache-Control": "private, max-age=300",
  };
  if (image.body?.length) headers["Content-Length"] = image.body.length;
  return headers;
}

function formatSafeError(error) {
  return {
    name: error?.name || "Error",
    code: error?.code || error?.errno || "",
    message: sanitizeErrorMessage(error?.message || String(error || "Unknown error")),
  };
}

function sanitizeErrorMessage(message) {
  let safeMessage = message;
  if (process.env.DATABASE_URL) {
    safeMessage = safeMessage.replaceAll(process.env.DATABASE_URL, "[DATABASE_URL]");
    try {
      const parsed = new URL(process.env.DATABASE_URL);
      if (parsed.password) safeMessage = safeMessage.replaceAll(parsed.password, "[PASSWORD]");
      if (parsed.username) safeMessage = safeMessage.replaceAll(parsed.username, "[USERNAME]");
    } catch {
      // Ignore malformed URLs here; the original parse error is more useful.
    }
  }
  return safeMessage;
}

function getAuthenticatedUser(req) {
  const authorization = req.headers.authorization || "";
  const [type, token] = authorization.split(" ");
  return type === "Bearer" ? verifySessionToken(token) : null;
}

function isValidCronRequest(req) {
  const secret = String(process.env.CRON_SECRET || "").trim();
  if (!secret) return false;
  return req.headers.authorization === `Bearer ${secret}`;
}

function elderlyAlertMonthlyRunKey(date = new Date()) {
  return `elderly-alerts-${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function requireAdmin(res, user, message) {
  if (user?.isAdmin) return true;
  sendJson(res, 403, { message });
  return false;
}

function isTruthyQueryValue(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function statusError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function isAdminOnlyMutation(url, method) {
  return (
    (url.pathname === "/api/people" && method === "POST") ||
    (url.pathname === "/api/admin/renumber-sno" && method === "POST") ||
    (url.pathname === "/api/admin/elderly-alerts/run" && method === "POST") ||
    (url.pathname === "/api/admin/normalize-departments" && method === "POST") ||
    (url.pathname === "/api/admin/clean-emails" && method === "POST") ||
    (url.pathname === "/api/admin/clean-placeholder-text" && method === "POST") ||
    (url.pathname === "/api/admin/import-statuses" && method === "POST") ||
    (url.pathname === "/api/admin/map-major-centres" && method === "POST") ||
    (method === "DELETE" && /^\/api\/people\/\d+$/.test(url.pathname)) ||
    (method === "POST" && /^\/api\/audits\/\d+\/restore$/.test(url.pathname))
  );
}

function adminOnlyMessage(url, method) {
  if (url.pathname === "/api/people" && method === "POST") {
    return "Only admin users can create users.";
  }
  if (url.pathname === "/api/admin/renumber-sno" && method === "POST") {
    return "Only admin users can renumber S No values.";
  }
  if (url.pathname === "/api/admin/elderly-alerts/run" && method === "POST") {
    return "Only admin users can run elderly alert scans.";
  }
  if (url.pathname === "/api/admin/normalize-departments" && method === "POST") {
    return "Only admin users can normalize departments.";
  }
  if (url.pathname === "/api/admin/clean-emails" && method === "POST") {
    return "Only admin users can clean email values.";
  }
  if (url.pathname === "/api/admin/clean-placeholder-text" && method === "POST") {
    return "Only admin users can clean placeholder field values.";
  }
  if (url.pathname === "/api/admin/import-statuses" && method === "POST") {
    return "Only admin users can import status values.";
  }
  if (url.pathname === "/api/admin/map-major-centres" && method === "POST") {
    return "Only admin users can map Major Centre values.";
  }
  if (method === "DELETE" && /^\/api\/people\/\d+$/.test(url.pathname)) {
    return "Only admin users can delete users.";
  }
  return "Only admin users can restore deleted users.";
}

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function authErrorResponse(error) {
  if (error instanceof AuthConfigurationError) {
    return {
      message: "Authentication is not configured.",
      error: formatSafeError(error),
    };
  }
  return null;
}

function auditWorkbookRows(audits) {
  return audits.flatMap((entry) => {
    const changes = Object.entries(entry.change || {});
    const base = [
      entry.id,
      entry.action || "update",
      formatAuditTimestamp(entry.createdAt),
      entry.changedBy || "system",
      entry.personId,
      entry.name,
      entry.badgeNo,
    ];

    if (!changes.length) return [[...base, "", "", ""]];

    return changes.map(([field, values]) => [
      ...base,
      field,
      auditCellValue(values?.old),
      auditCellValue(values?.new),
    ]);
  });
}

function isPrPerson(person) {
  return String(person.data?.["Badge no."] || person.badgeNo || "")
    .trim()
    .toUpperCase()
    .startsWith("PR");
}

function compareByPrSerialNumber(left, right) {
  const leftSerial = prSerialNumber(left.data?.["S No"]);
  const rightSerial = prSerialNumber(right.data?.["S No"]);
  if (leftSerial !== rightSerial) return leftSerial - rightSerial;
  return String(left.data?.["Badge no."] || left.badgeNo || "").localeCompare(
    String(right.data?.["Badge no."] || right.badgeNo || ""),
    "en",
    { numeric: true, sensitivity: "base" }
  );
}

function prSerialNumber(value) {
  const serial = String(value || "").trim();
  return /^\d+$/.test(serial) ? Number(serial) : Number.MAX_SAFE_INTEGER;
}

function sbmExportCellValue(person, field) {
  const data = person.data || {};
  const newAddress = String(data["New Address"] || "").trim();

  if (field === "Aadhaar No") return lastFourDigits(data[field]);
  if (field === "Gender") return sbmGenderValue(data[field]);
  if (field === "Address Line 1" && newAddress) return newAddress;
  if (field === "Address Line 2" && newAddress) return "";
  if (field === "Photo File Name") {
    const badgeNo = String(data["Badge no."] || person.badgeNo || "").trim();
    return badgeNo ? `${badgeNo}.jpg` : "";
  }
  if (field === "Initiation Place") return data.INITIATION_PLACE || "";

  return data[field] || "";
}

function lastFourDigits(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(-4);
  return digits ? Number(digits) : "";
}

function sbmGenderValue(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "MALE" || normalized === "M") return "M";
  if (normalized === "FEMALE" || normalized === "F") return "F";
  return String(value || "").trim();
}

function formatAuditTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function auditCellValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function readJson(req, { maxBytes = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    let body = "";
    let byteLength = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      byteLength += chunk.length;
      if (byteLength > maxBytes) {
        rejected = true;
        reject(statusError(413, "Request body too large."));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (rejected) return;
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", (error) => {
      if (!rejected) reject(error);
    });
  });
}

function safeHeaderFileName(value) {
  return String(value || "photo").replace(/["\r\n]/g, "_");
}

function formatBytes(value) {
  if (value >= 1024 * 1024) return `${Math.floor(value / (1024 * 1024))} MB`;
  if (value >= 1024) return `${Math.floor(value / 1024)} KB`;
  return `${value} bytes`;
}
