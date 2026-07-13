import { closeDatabase, reseedDatabase } from "./database.mjs";

await reseedDatabase();
await closeDatabase();
console.log("Database reseeded from data/people-seed.json");
