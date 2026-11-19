// Single integration boundary for the Claude Agent SDK. Keep direct package
// imports here so runtime swaps and compatibility tests have one place to land.

import {
	createSdkMcpServer as anthropicCreateSdkMcpServer,
	query as anthropicQuery,
	tool as anthropicTool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
	AnyZodRawShape,
	HookCallbackMatcher,
	HookInput,
	HookJSONOutput,
	McpSdkServerConfigWithInstance,
	McpServerConfig,
	Query,
	SDKMessage,
	SDKSystemMessage,
	SDKUserMessage,
	SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { type AgentRuntimeKind, resolveAgentSdkRuntime } from "./agent-sdk-loader.ts";

export type {
	HookCallbackMatcher,
	HookInput,
	HookJSONOutput,
	McpSdkServerConfigWithInstance,
	McpServerConfig,
	Query,
	SDKMessage,
	SDKSystemMessage,
	SDKUserMessage,
};

export type AgentSdkQueryParams = Parameters<typeof anthropicQuery>[0];
export type AgentSdkQueryOptions = NonNullable<AgentSdkQueryParams["options"]> & {
	transformContext?: (messages: unknown[], signal?: AbortSignal) => Promise<unknown[]> | unknown[];
};
export type AgentSdkQuery = (params: AgentSdkQueryParams) => Query;
export type AgentSdkRuntimeSelection = {
	agentRuntime: AgentRuntimeKind;
	env?: Record<string, string | undefined>;
};
type AgentSdkToolExtras = {
	annotations?: ToolAnnotations;
	searchHint?: string;
};

const defaultRuntime = {
	query: anthropicQuery,
	createSdkMcpServer: anthropicCreateSdkMcpServer,
	tool: anthropicTool,
};
let activeRuntime = await resolveAgentSdkRuntime({ defaultRuntime, env: process.env });
let activeQuery: AgentSdkQuery = activeRuntime.query;

export function createSdkMcpServer(
	...args: Parameters<typeof anthropicCreateSdkMcpServer>
): ReturnType<typeof anthropicCreateSdkMcpServer> {
	return activeRuntime.createSdkMcpServer(...args);
}

export function tool<Schema extends AnyZodRawShape>(
	name: string,
	description: string,
	inputSchema: Schema,
	handler: SdkMcpToolDefinition<Schema>["handler"],
	extras?: AgentSdkToolExtras,
): SdkMcpToolDefinition<Schema> {
	return activeRuntime.tool(name, description, inputSchema, handler, extras);
}

export function query(params: AgentSdkQueryParams): Query {
	return activeQuery(applyModelLock(params));
}

const LOCKED_EFFORTS = new Set(["low", "medium", "high", "max"]);

/**
 * Operator lock, set in the container environment so nothing reachable from a
 * chat can change it. PHANTOM_MODEL_LOCK forces every SDK call (chat, judges,
 * reflection, scheduler) onto one model, including the subprocess's own
 * opus/sonnet/haiku aliases and subagents; PHANTOM_EFFORT_LOCK does the same
 * for effort. Unset: calls pass through unchanged.
 */
export function applyModelLock(
	params: AgentSdkQueryParams,
	env: Record<string, string | undefined> = process.env,
): AgentSdkQueryParams {
	const model = env.PHANTOM_MODEL_LOCK?.trim();
	const effort = env.PHANTOM_EFFORT_LOCK?.trim();
	if (!model && !effort) return params;

	const options: Record<string, unknown> = { ...(params.options ?? {}) };
	if (model) {
		options.model = model;
		options.env = {
			...((options.env as Record<string, string | undefined> | undefined) ?? process.env),
			ANTHROPIC_MODEL: model,
			ANTHROPIC_DEFAULT_OPUS_MODEL: model,
			ANTHROPIC_DEFAULT_SONNET_MODEL: model,
			ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
			ANTHROPIC_SMALL_FAST_MODEL: model,
			CLAUDE_CODE_SUBAGENT_MODEL: model,
		};
	}
	if (effort && LOCKED_EFFORTS.has(effort)) {
		options.effort = effort;
	}
	return { ...params, options: options as AgentSdkQueryParams["options"] };
}

export async function configureAgentSdkRuntime(input: AgentSdkRuntimeSelection): Promise<void> {
	activeRuntime = await resolveAgentSdkRuntime({
		defaultRuntime,
		agentRuntime: input.agentRuntime,
		env: input.env,
	});
	activeQuery = activeRuntime.query;
}

export function __setAgentSdkQueryForTests(queryOverride: AgentSdkQuery | null): void {
	activeQuery = queryOverride ?? activeRuntime.query;
}
