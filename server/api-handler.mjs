import {
  checkDatabaseConnection,
  databaseProvider,
  dropdownOptions,
  fields,
  getPerson,
  getVerificationSummary,
  initializeDatabase,
  listAuditLogs,
  listAllPeople,
  listPeople,
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

    if (url.pathname.startsWith("/api/") && !isAuthorized(req)) {
      sendJson(res, 401, { message: "Authentication required." });
      return;
    }

    await ensureDatabaseInitialized();

    if (url.pathname === "/api/fields" && req.method === "GET") {
      sendJson(res, 200, { fields, searchableFields, dropdownOptions });
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

    if (url.pathname === "/api/summary" && req.method === "GET") {
      const department = url.searchParams.get("department") || "";
      sendJson(res, 200, await getVerificationSummary({ department }));
      return;
    }

    if (url.pathname === "/api/audits" && req.method === "GET") {
      const limit = url.searchParams.get("limit") || "500";
      sendJson(res, 200, {
        results: await listAuditLogs({ limit }),
      });
      return;
    }

    if (url.pathname === "/api/people" && req.method === "GET") {
      const query = url.searchParams.get("q") || "";
      const field = url.searchParams.get("field") || "All fields";
      const limit = url.searchParams.get("limit") || "200";
      sendJson(res, 200, await listPeople({ query, field, limit }));
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
      const person = await updatePerson(personMatch[1], body.data || {});
      if (!person) {
        sendJson(res, 404, { message: "Person not found." });
        return;
      }
      sendJson(res, 200, person);
      return;
    }

    sendJson(res, 404, { message: "API route not found." });
  } catch (error) {
    console.error(error);
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

function isAuthorized(req) {
  const authorization = req.headers.authorization || "";
  const [type, token] = authorization.split(" ");
  return type === "Bearer" && Boolean(verifySessionToken(token));
}

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
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
