import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const env = { ...process.env, PORT: process.env.PORT || "4000" };

const processes = [
  spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "server/index.mjs"], { stdio: "inherit", env }),
  spawn(npm, ["run", "client"], { stdio: "inherit", env })
];

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of processes) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(code);
}

for (const child of processes) {
  child.on("exit", (code) => {
    if (!shuttingDown && code !== 0) shutdown(code ?? 1);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
