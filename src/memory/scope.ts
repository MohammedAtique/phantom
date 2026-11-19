/**
 * Memory scopes.
 *
 * Every episode and fact is written with a `scope`. A Telegram forum topic gets
 * its own scope (`telegram:<chatId>:<topicId>`), so a new topic starts with no
 * recalled history. Everything else (private chats, a group's General topic,
 * Slack, web chat, email, ...) writes to the global scope.
 *
 * Reads are layered: a topic recalls its own memories plus global ones, and the
 * global scope recalls only global memories. Points written before scopes
 * existed have no `scope` field and are treated as global.
 *
 * Rules that live outside the vector store (constitution, persona, role and
 * the evolved phantom-config files) are not scoped and apply everywhere.
 */

export const GLOBAL_SCOPE = "global";

const TELEGRAM_TOPIC = /^telegram:(-?\d+):(\d+)$/;

export function memoryScopeFor(channelId: string, conversationId: string): string {
	if (channelId === "telegram") {
		const m = TELEGRAM_TOPIC.exec(conversationId);
		if (m) return `telegram:${m[1]}:${m[2]}`;
	}
	return GLOBAL_SCOPE;
}

export function readableScopes(scope: string | undefined): string[] {
	if (!scope || scope === GLOBAL_SCOPE) return [GLOBAL_SCOPE];
	return [scope, GLOBAL_SCOPE];
}

/** Qdrant condition matching any of `scopes`; unscoped legacy points count as global. */
export function scopeCondition(scopes: string[]): Record<string, unknown> {
	const should: Record<string, unknown>[] = [{ key: "scope", match: { any: scopes } }];
	if (scopes.includes(GLOBAL_SCOPE)) should.push({ is_empty: { key: "scope" } });
	return { should };
}
