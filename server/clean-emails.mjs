import { cleanEmailValues, closeDatabase } from "./database.mjs";

const updated = await cleanEmailValues();
await closeDatabase();
console.log(`Cleaned ${updated} email value${updated === 1 ? "" : "s"}.`);
