import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForLine(lines: string[], index: number, timeoutMs = 3000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (lines[index] !== undefined) {
            return lines[index];
        }
        await delay(10);
    }
    throw new Error(`Timed out waiting for stdout line ${index + 1}.`);
}

test("stdio server exposes only the lean tool surface and valid JSON-RPC", { timeout: 8000 }, async (t) => {
    const child = spawn(process.execPath, [resolve(projectRoot, "dist/index.js")], {
        cwd: projectRoot,
        env: {
            ...process.env,
            BESTBUY_API_KEY: "",
            MCP_LEGACY_TOOLS: "",
            MCP_DEBUG_ERRORS: "",
        },
        stdio: ["pipe", "pipe", "pipe"],
    });

    t.after(() => {
        if (!child.killed) {
            child.kill();
        }
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const lines: string[] = [];
    let partial = "";
    let stderr = "";

    child.stdout.on("data", (chunk: string) => {
        partial += chunk;
        while (partial.includes("\n")) {
            const newline = partial.indexOf("\n");
            const line = partial.slice(0, newline).trim();
            partial = partial.slice(newline + 1);
            if (line) {
                lines.push(line);
            }
        }
    });
    child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
    });

    await delay(200);
    assert.equal(lines.length, 0, `Server emitted unsolicited stdout: ${lines.join(" | ")}`);
    assert.equal(partial, "", `Server emitted partial unsolicited stdout: ${partial}`);
    assert.equal(child.exitCode, null, `Server exited during startup. stderr: ${stderr}`);

    child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "protocol-test", version: "1.0.0" },
        },
    })}\n`);

    const initializeLine = await waitForLine(lines, 0);
    const initializeResponse = JSON.parse(initializeLine) as Record<string, unknown>;
    assert.equal(initializeResponse.jsonrpc, "2.0");
    assert.equal(initializeResponse.id, 1);
    assert.ok(initializeResponse.result);

    child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
    })}\n`);
    child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
    })}\n`);

    const toolsLine = await waitForLine(lines, 1);
    const toolsResponse = JSON.parse(toolsLine) as {
        jsonrpc?: string;
        id?: number;
        result?: { tools?: Array<{ name?: string }> };
    };
    assert.equal(toolsResponse.jsonrpc, "2.0");
    assert.equal(toolsResponse.id, 2);
    assert.deepEqual(
        toolsResponse.result?.tools?.map((tool) => tool.name),
        ["search_products", "get_product"],
    );

    child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
            name: "search_products",
            arguments: {
                marketplace: "bestbuy",
                query: "test product",
            },
        },
    })}\n`);

    const failedProviderLine = await waitForLine(lines, 2);
    const failedProviderResponse = JSON.parse(failedProviderLine) as {
        jsonrpc?: string;
        id?: number;
        result?: {
            isError?: boolean;
            structuredContent?: Record<string, unknown>;
            content?: Array<{ type?: string; text?: string }>;
        };
    };
    assert.equal(failedProviderResponse.jsonrpc, "2.0");
    assert.equal(failedProviderResponse.id, 3);
    assert.equal(failedProviderResponse.result?.isError, true);
    assert.equal(failedProviderResponse.result?.content?.[0]?.text, "Best Buy search failed.");
    assert.deepEqual(failedProviderResponse.result?.structuredContent, { error: "request_failed" });

    for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line), `Invalid stdout JSON: ${line}`);
    }
});
