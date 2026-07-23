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
  getLocationOptions,
  getVerificationSummary,
  importStatusValues,
  initializeDatabase,
  listAuditLogs,
  listAllAuditLogs,
  listAllPeople,
  listDataQualityPeople,
  listPeople,
  mapMajorCentresFromDepartments,
  normalizeDepartmentValues,
  renumberSerialNumbers,
  restorePersonFromAudit,
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

    if (url.pathname === "/api/summary/data-quality" && req.method === "GET") {
      sendJson(res, 200, await getDataQualitySummary());
      return;
    }

    if (url.pathname === "/api/summary/data-quality/people" && req.method === "GET") {
      sendJson(res, 200, await listDataQualityPeople({
        field: url.searchParams.get("field") || "",
        issue: url.searchParams.get("issue") || "",
        group: url.searchParams.get("group") || "",
      }));
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

function requireAdmin(res, user, message) {
  if (user?.isAdmin) return true;
  sendJson(res, 403, { message });
  return false;
}

function isAdminOnlyMutation(url, method) {
  return (
    (url.pathname === "/api/people" && method === "POST") ||
    (url.pathname === "/api/admin/renumber-sno" && method === "POST") ||
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

  if (field === "Address Line 1" && newAddress) return newAddress;
  if (field === "Address Line 2" && newAddress) return "";
  if (field === "Photo File Name") {
    const badgeNo = String(data["Badge no."] || person.badgeNo || "").trim();
    return badgeNo ? `${badgeNo}.jpg` : "";
  }
  if (field === "Initiation Place") return data.INITIATION_PLACE || "";

  return data[field] || "";
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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
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
    req.on("error", reject);
  });
}
