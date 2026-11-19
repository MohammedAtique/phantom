import { describe, expect, test } from "bun:test";
import { applyModelLock } from "../agent-sdk.ts";

const base = { prompt: "hi", options: { model: "claude-haiku-4-5", effort: "max" as const, env: { FOO: "1" } } };

describe("applyModelLock", () => {
	test("no lock: params pass through untouched", () => {
		expect(applyModelLock(base, {})).toBe(base);
	});

	test("model lock overrides the requested model and every alias the subprocess uses", () => {
		const out = applyModelLock(base, { PHANTOM_MODEL_LOCK: "claude-opus-5-5" });
		const opts = out.options as Record<string, unknown>;
		const env = opts.env as Record<string, string>;
		expect(opts.model).toBe("claude-opus-5-5");
		expect(env.FOO).toBe("1");
		for (const k of [
			"ANTHROPIC_MODEL",
			"ANTHROPIC_DEFAULT_OPUS_MODEL",
			"ANTHROPIC_DEFAULT_SONNET_MODEL",
			"ANTHROPIC_DEFAULT_HAIKU_MODEL",
			"ANTHROPIC_SMALL_FAST_MODEL",
			"CLAUDE_CODE_SUBAGENT_MODEL",
		]) {
			expect(env[k]).toBe("claude-opus-5-5");
		}
		expect(opts.effort).toBe("max");
	});

	test("effort lock overrides effort; invalid values are ignored", () => {
		const env = { PHANTOM_MODEL_LOCK: "claude-opus-5-5", PHANTOM_EFFORT_LOCK: "low" };
		expect((applyModelLock(base, env).options as Record<string, unknown>).effort).toBe("low");
		const bad = applyModelLock(base, { PHANTOM_EFFORT_LOCK: "turbo" });
		expect((bad.options as Record<string, unknown>).effort).toBe("max");
	});

	test("a call with no options still gets the lock", () => {
		const out = applyModelLock({ prompt: "x" }, { PHANTOM_MODEL_LOCK: "claude-opus-5-5", PHANTOM_EFFORT_LOCK: "low" });
		expect((out.options as Record<string, unknown>).model).toBe("claude-opus-5-5");
		expect((out.options as Record<string, unknown>).effort).toBe("low");
	});
});
