import { closeDatabase, normalizePersonCoreFields } from "../server/database.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const batchSizeArg = args.find((arg) => arg.startsWith("--batch-size="));
const batchSize = batchSizeArg ? Number(batchSizeArg.split("=")[1]) : undefined;

try {
  const result = await normalizePersonCoreFields({
    dryRun,
    batchSize,
    returnSummary: true,
    changedBy: "normalize-person-core-fields",
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeDatabase();
}
