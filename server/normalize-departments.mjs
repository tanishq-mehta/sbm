import { closeDatabase, normalizeDepartmentValues } from "./database.mjs";

const updated = await normalizeDepartmentValues();
await closeDatabase();
console.log(`Normalized ${updated} department record${updated === 1 ? "" : "s"}.`);
