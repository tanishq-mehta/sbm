import { handleApiRequest } from "../server/api-handler.mjs";

export default async function handler(req, res) {
  await handleApiRequest(req, res);
}
