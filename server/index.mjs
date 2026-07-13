import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
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

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || "0.0.0.0";
const authToken = "dev-admin-token";

await initializeDatabase();

const server = http.createServer(async (req, res) => {
  try {
    applyCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, database: databaseProvider });
      return;
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = await readJson(req);
      if (body.username === "admin" && body.password === "123456") {
        sendJson(res, 200, {
          token: authToken,
          user: { username: "admin" },
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

    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { message: "API route not found." });
      return;
    }

    serveStatic(url, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { message: "Unexpected server error." });
  }
});

server.listen(port, host, () => {
  console.log(`API server listening on ${host}:${port}`);
});

function isAuthorized(req) {
  return req.headers.authorization === `Bearer ${authToken}`;
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

function serveStatic(url, res) {
  if (!fs.existsSync(distDir)) {
    sendJson(res, 404, {
      message: "Frontend build not found. Run npm run dev for development or npm run build before npm start.",
    });
    return;
  }

  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(distDir, safePath);

  if (!filePath.startsWith(distDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, "index.html");
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  }[ext] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(res);
}
