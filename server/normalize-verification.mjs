import { closeDatabase, normalizeVerificationValues } from "./database.mjs";

const updated = await normalizeVerificationValues();
await closeDatabase();
console.log(`Normalized ${updated} verification value${updated === 1 ? "" : "s"}.`);
