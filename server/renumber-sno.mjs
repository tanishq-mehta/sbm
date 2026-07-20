import { closeDatabase, renumberSerialNumbers } from "./database.mjs";

const dryRun = process.argv.includes("--dry-run");
const batchSizeArg = process.argv.find((arg) => arg.startsWith("--batch-size="));
const batchSize = batchSizeArg ? Number(batchSizeArg.split("=")[1]) : undefined;

const result = await renumberSerialNumbers({ batchSize, dryRun });
await closeDatabase();

const action = dryRun ? "Would normalize" : "Normalized";
console.log(`${action} ${result.updated} S No record${result.updated === 1 ? "" : "s"}.`);
console.log(`Active records: ${result.total}. Batch size: ${result.batchSize}.`);
for (const group of ["PR", "EC"]) {
  const summary = result.groups?.[group];
  if (!summary) continue;
  console.log(`${group} records: ${summary.total}.`);
  if (summary.first) {
    console.log(`  First: ${summary.first.serial} ${summary.first.badgeNo} ${summary.first.name}`.trim());
  }
  if (summary.last) {
    console.log(`  Last: ${summary.last.serial} ${summary.last.badgeNo} ${summary.last.name}`.trim());
  }
}
if (result.skipped?.length) {
  console.log(`Skipped ${result.skipped.length} records without PR/EC badge prefixes.`);
}
