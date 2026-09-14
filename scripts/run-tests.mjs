import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function collectTests(directory) {
    return readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) return collectTests(path);
            return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
        })
        .sort();
}

const tests = collectTests("test");
if (tests.length === 0) {
    console.error("No TypeScript tests were found under test/.");
    process.exit(1);
}

const executable = process.platform === "win32" ? "tsx.cmd" : "tsx";
const result = spawnSync(executable, ["--test", ...tests], {
    stdio: "inherit",
    shell: false,
});

if (result.error) {
    console.error(result.error.message);
    process.exit(1);
}
process.exit(result.status ?? 1);
