import { closeDatabase, renumberSerialNumbers } from "./database.mjs";

const dryRun = process.argv.includes("--dry-run");
const batchSizeArg = process.argv.find((arg) => arg.startsWith("--batch-size="));
const batchSize = batchSizeArg ? Number(batchSizeArg.split("=")[1]) : undefined;

const result = await renumberSerialNumbers({ batchSize, dryRun });
await closeDatabase();

const action = dryRun ? "Would normalize" : "Normalized";
console.log(`${action} ${result.updated} S No record${result.updated === 1 ? "" : "s"}.`);
console.log(`Active records: ${result.total}. Batch size: ${result.batchSize}.`);
if (result.first) {
  console.log(`First: ${result.first.serial} ${result.first.badgeNo} ${result.first.name}`.trim());
}
if (result.last) {
  console.log(`Last: ${result.last.serial} ${result.last.badgeNo} ${result.last.name}`.trim());
}
