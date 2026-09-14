import assert from "node:assert/strict";
import test from "node:test";
import { money, toNumberOrNull } from "../src/common.js";

test("toNumberOrNull accepts formatted provider strings", () => {
    assert.equal(toNumberOrNull("$1,299.99"), 1299.99);
    assert.equal(toNumberOrNull("EUR 42.50"), 42.5);
});

test("toNumberOrNull unwraps common nested price shapes", () => {
    assert.equal(toNumberOrNull({ value: "199.95" }), 199.95);
    assert.equal(toNumberOrNull({ amount: 89 }), 89);
    assert.equal(toNumberOrNull({ extracted: "$12.34" }), 12.34);
});

test("money picks up currency from nested provider values", () => {
    assert.deepEqual(money({ value: "49.99", currency: "USD" }, undefined), {
        value: 49.99,
        currency: "USD",
    });
});
