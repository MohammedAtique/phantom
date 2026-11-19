import { describe, expect, test } from "bun:test";
import { GLOBAL_SCOPE, memoryScopeFor, readableScopes, scopeCondition } from "../scope.ts";

describe("memory scopes", () => {
	test("a Telegram forum topic gets its own scope", () => {
		expect(memoryScopeFor("telegram", "telegram:-1001:55")).toBe("telegram:-1001:55");
	});

	test("private chats, General and other channels are global", () => {
		expect(memoryScopeFor("telegram", "telegram:12345")).toBe(GLOBAL_SCOPE);
		expect(memoryScopeFor("telegram", "telegram:-1001")).toBe(GLOBAL_SCOPE);
		expect(memoryScopeFor("slack", "C123:1700000000.1")).toBe(GLOBAL_SCOPE);
		expect(memoryScopeFor("web", "telegram:-1001:55")).toBe(GLOBAL_SCOPE);
	});

	test("a topic reads itself plus global; global reads only global", () => {
		expect(readableScopes("telegram:-1001:55")).toEqual(["telegram:-1001:55", GLOBAL_SCOPE]);
		expect(readableScopes(GLOBAL_SCOPE)).toEqual([GLOBAL_SCOPE]);
		expect(readableScopes(undefined)).toEqual([GLOBAL_SCOPE]);
	});

	test("global reads include points written before scopes existed", () => {
		expect(scopeCondition([GLOBAL_SCOPE])).toEqual({
			should: [{ key: "scope", match: { any: [GLOBAL_SCOPE] } }, { is_empty: { key: "scope" } }],
		});
		expect(scopeCondition(["telegram:-1001:55"])).toEqual({
			should: [{ key: "scope", match: { any: ["telegram:-1001:55"] } }],
		});
	});
});
