import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const printableAscii = /^[\x09\x0A\x0D\x20-\x7E]*$/;

function collectFiles(path: string): string[] {
    if (!statSync(path).isDirectory()) {
        return [path];
    }

    return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
        const child = resolve(path, entry.name);
        return entry.isDirectory() ? collectFiles(child) : [child];
    });
}

test("authored source and documentation contain no emoji or non-ASCII symbols", () => {
    const files = [
        ...collectFiles(resolve(projectRoot, "src")),
        ...collectFiles(resolve(projectRoot, "test")),
        ...collectFiles(resolve(projectRoot, ".github")),
        resolve(projectRoot, "README.md"),
        resolve(projectRoot, "package.json"),
        resolve(projectRoot, "tsconfig.json"),
        resolve(projectRoot, ".env.example"),
    ];

    for (const file of files) {
        const contents = readFileSync(file, "utf8");
        assert.match(
            contents,
            printableAscii,
            `${relative(projectRoot, file)} contains an emoji or non-ASCII symbol.`,
        );
    }
});
