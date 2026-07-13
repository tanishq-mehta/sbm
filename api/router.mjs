import { handleApiRequest } from "../server/api-handler.mjs";

export default async function handler(req, res) {
  const rewrittenUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const routePath = getRoutePath(req, rewrittenUrl);

  if (routePath) {
    rewrittenUrl.searchParams.delete("path");
    req.url = `/api/${routePath}${rewrittenUrl.search || ""}`;
  }

  await handleApiRequest(req, res);
}

function getRoutePath(req, url) {
  const queryPath = req.query?.path || url.searchParams.get("path");
  const rawPath = Array.isArray(queryPath) ? queryPath.join("/") : queryPath;
  return rawPath ? String(rawPath).replace(/^\/+/, "") : "";
}
