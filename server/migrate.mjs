import { closeDatabase, initializeDatabase } from "./database.mjs";

await initializeDatabase({ seedIfEmpty: false });
await closeDatabase();
console.log("Database schema is ready.");
