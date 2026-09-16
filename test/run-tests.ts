import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const testFiles = readdirSync(testDirectory)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => resolve(testDirectory, name));

if (testFiles.length === 0) {
    throw new Error("No test files were discovered.");
}

const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", ...testFiles],
    { stdio: "inherit" },
);

if (result.error) {
    throw result.error;
}
process.exitCode = result.status ?? 1;
