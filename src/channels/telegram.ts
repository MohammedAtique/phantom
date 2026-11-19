/**
 * Telegram channel using Telegraf (long polling).
 * Supports inline keyboards, persistent typing, message editing,
 * MarkdownV2 formatting, and command handling.
 *
 * Forum topics: a message in a topic gets conversation id
 * `telegram:<chatId>:<topicId>`, so each topic is its own session and its own
 * memory scope (see memory/scope.ts). Private chats and a group's General
 * topic use `telegram:<chatId>`.
 *
 * Access: owners (`ownerIds`) are always answered. An owner sends /start once in
 * a topic (or General, or a group) to authorize it; after that anyone there is
 * answered. /revoke undoes it. Authorizations persist in `authFile`.
 * Everywhere else only owners are answered; an empty owner list answers nobody.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";

type TelegrafBot = {
	launch: (onLaunch?: () => void) => Promise<void>;
	stop: () => void;
	command: (cmd: string, handler: (ctx: TelegrafContext) => Promise<void>) => void;
	on: (event: string, handler: (ctx: TelegrafContext) => Promise<void>) => void;
	action: (pattern: RegExp, handler: (ctx: TelegrafContext) => Promise<void>) => void;
	telegram: TelegramApi;
};

type TelegramApi = {
	sendMessage: (
		chatId: number | string,
		text: string,
		options?: Record<string, unknown>,
	) => Promise<{ message_id: number }>;
	editMessageText: (
		chatId: number | string,
		messageId: number,
		inlineMessageId: string | undefined,
		text: string,
		options?: Record<string, unknown>,
	) => Promise<unknown>;
	sendChatAction: (chatId: number | string, action: string, options?: Record<string, unknown>) => Promise<void>;
};

type TelegrafContext = {
	message?: {
		text?: string;
		from?: { id: number; first_name?: string; username?: string };
		chat: { id: number };
		message_id: number;
		message_thread_id?: number;
		is_topic_message?: boolean;
	};
	reply: (text: string, options?: Record<string, unknown>) => Promise<{ message_id: number }>;
	telegram: TelegramApi;
	chat?: { id: number };
	from?: { id: number; first_name?: string; username?: string };
	match?: RegExpMatchArray;
	answerCbQuery?: (text?: string) => Promise<void>;
	callbackQuery?: {
		data?: string;
		message?: {
			message_id: number;
			chat: { id: number };
			message_thread_id?: number;
			is_topic_message?: boolean;
		};
	};
};

export type TelegramChannelConfig = {
	botToken: string;
	/** Telegram user IDs allowed to talk to the bot. Empty or missing: nobody. */
	ownerIds?: number[];
	/** First reconnect delay after polling dies; doubles up to 60s. Default 5000. */
	reconnectBaseMs?: number;
	/** Where owner /start authorizations are saved. Without it they last until restart. */
	authFile?: string;
};

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export class TelegramChannel implements Channel {
	readonly id = "telegram";
	readonly name = "Telegram";
	readonly capabilities: ChannelCapabilities = {
		threads: false,
		richText: true,
		attachments: true,
		buttons: true,
		inlineKeyboards: true,
		typing: true,
		messageEditing: true,
	};

	private bot: TelegrafBot | null = null;
	private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
	private connectionState: ConnectionState = "disconnected";
	private config: TelegramChannelConfig;
	// Typing keepalive timers per chat (and topic)
	private typingTimers = new Map<string, ReturnType<typeof setInterval>>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempt = 0;
	private stopped = false;
	// Places an owner authorized with /start: "<chatId>:<topicId>" or "<chatId>:main"
	private authorized = new Set<string>();

	constructor(config: TelegramChannelConfig) {
		this.config = config;
		this.loadAuthorized();
	}

	async connect(): Promise<void> {
		if (this.connectionState === "connected") return;
		this.connectionState = "connecting";
		this.stopped = false;

		try {
			const { Telegraf } = await import("telegraf");
			this.bot = new Telegraf(this.config.botToken) as unknown as TelegrafBot;

			if (!this.config.ownerIds?.length && this.reconnectAttempt === 0) {
				console.warn(
					"[telegram] No owner_ids configured: every message will be refused. " +
						"Send /start to the bot to see your user ID, then set TELEGRAM_OWNER_IDS.",
				);
			}

			this.registerHandlers();
			// Telegraf >= 4.16: launch() resolves only when polling stops, so awaiting it
			// never returns. onLaunch fires once getMe() has verified the token.
			const bot = this.bot;
			await new Promise<void>((resolve, reject) => {
				let launched = false;
				bot
					.launch(() => {
						launched = true;
						resolve();
					})
					.catch((err: unknown) => {
						if (!launched) return reject(err);
						// A dropped long-poll request (e.g. ECONNRESET) ends Telegraf's polling
						// loop for good, so the bot would stay deaf. Reconnect with backoff.
						if (this.stopped || this.bot !== bot) return;
						this.connectionState = "error";
						const msg = err instanceof Error ? err.message : String(err);
						console.error(`[telegram] Polling stopped: ${msg}`);
						this.scheduleReconnect();
					});
			});
			this.connectionState = "connected";
			this.reconnectAttempt = 0;
			console.log("[telegram] Bot connected via long polling");
		} catch (err: unknown) {
			this.connectionState = "error";
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[telegram] Failed to connect: ${msg}`);
			throw err;
		}
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer) return;
		const base = this.config.reconnectBaseMs ?? 5000;
		const delay = Math.min(base * 2 ** this.reconnectAttempt, 60_000);
		this.reconnectAttempt++;
		console.log(`[telegram] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempt})`);
		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null;
			if (this.stopped) return;
			try {
				this.bot?.stop();
			} catch {
				// polling already ended
			}
			this.bot = null;
			this.connectionState = "disconnected";
			try {
				await this.connect();
			} catch {
				this.scheduleReconnect();
			}
		}, delay);
	}

	async disconnect(): Promise<void> {
		this.stopped = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.connectionState === "disconnected") return;

		// Clear all typing timers
		for (const timer of this.typingTimers.values()) {
			clearInterval(timer);
		}
		this.typingTimers.clear();

		try {
			this.bot?.stop();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[telegram] Error during disconnect: ${msg}`);
		}

		this.connectionState = "disconnected";
		console.log("[telegram] Disconnected");
	}

	async send(conversationId: string, message: OutboundMessage): Promise<SentMessage> {
		if (!this.bot) throw new Error("Telegram bot not connected");

		const { chatId, threadId } = parseTelegramConversationId(conversationId);
		const text = escapeMarkdownV2(message.text);

		const result = await this.bot.telegram.sendMessage(chatId, text, {
			parse_mode: "MarkdownV2",
			...(threadId !== undefined ? { message_thread_id: threadId } : {}),
		});

		return {
			id: String(result.message_id),
			channelId: this.id,
			conversationId,
			timestamp: new Date(),
		};
	}

	onMessage(handler: (message: InboundMessage) => Promise<void>): void {
		this.messageHandler = handler;
	}

	isConnected(): boolean {
		return this.connectionState === "connected";
	}

	getConnectionState(): ConnectionState {
		return this.connectionState;
	}

	/** Start persistent typing indicator for a chat, inside a topic when threadId is given */
	startTyping(chatId: number, threadId?: number): void {
		this.stopTyping(chatId, threadId);
		const fire = () => {
			const action =
				threadId !== undefined
					? this.bot?.telegram.sendChatAction(chatId, "typing", { message_thread_id: threadId })
					: this.bot?.telegram.sendChatAction(chatId, "typing");
			void action?.catch(() => {});
		};
		// Telegram typing indicator expires after 5s, so re-fire every 4s
		fire();
		const timer = setInterval(fire, 4000);
		this.typingTimers.set(typingKey(chatId, threadId), timer);
	}

	/** Stop persistent typing indicator */
	stopTyping(chatId: number, threadId?: number): void {
		const key = typingKey(chatId, threadId);
		const timer = this.typingTimers.get(key);
		if (timer) {
			clearInterval(timer);
			this.typingTimers.delete(key);
		}
	}

	/** True when an owner authorized this chat/topic with /start. */
	isAuthorized(chatId: number, threadId: number | undefined): boolean {
		return this.authorized.has(placeKey(chatId, threadId));
	}

	/** Owners anywhere; anyone in an authorized chat/topic. */
	canUse(userId: number | undefined, chatId: number, threadId: number | undefined): boolean {
		return this.isOwner(userId) || this.isAuthorized(chatId, threadId);
	}

	setAuthorized(chatId: number, threadId: number | undefined, on: boolean): void {
		const key = placeKey(chatId, threadId);
		if (on) this.authorized.add(key);
		else this.authorized.delete(key);
		const file = this.config.authFile;
		if (!file) return;
		try {
			mkdirSync(dirname(file), { recursive: true });
			const tmp = `${file}.tmp`;
			writeFileSync(tmp, `${JSON.stringify([...this.authorized].sort(), null, 2)}\n`);
			renameSync(tmp, file);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[telegram] Could not save authorizations: ${msg}`);
		}
	}

	private loadAuthorized(): void {
		const file = this.config.authFile;
		if (!file) return;
		try {
			const list: unknown = JSON.parse(readFileSync(file, "utf-8"));
			if (Array.isArray(list)) for (const k of list) if (typeof k === "string") this.authorized.add(k);
		} catch {
			// no file yet
		}
	}

	/** Reply in the same chat and topic as the incoming message. */
	private async replyHere(chatId: number, threadId: number | undefined, text: string): Promise<void> {
		await this.bot?.telegram
			.sendMessage(chatId, text, threadId !== undefined ? { message_thread_id: threadId } : {})
			.catch(() => {});
	}

	/** True when the sender is in ownerIds. */
	isOwner(userId: number | undefined): boolean {
		return userId !== undefined && (this.config.ownerIds ?? []).includes(userId);
	}

	/** Send a message with inline keyboard buttons */
	async sendWithKeyboard(
		chatId: number,
		text: string,
		buttons: Array<Array<{ text: string; callback_data: string }>>,
		threadId?: number,
	): Promise<number> {
		if (!this.bot) throw new Error("Telegram bot not connected");

		const result = await this.bot.telegram.sendMessage(chatId, escapeMarkdownV2(text), {
			parse_mode: "MarkdownV2",
			reply_markup: { inline_keyboard: buttons },
			...(threadId !== undefined ? { message_thread_id: threadId } : {}),
		});
		return result.message_id;
	}

	/** Edit an existing message */
	async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
		if (!this.bot) return;
		try {
			await this.bot.telegram.editMessageText(chatId, messageId, undefined, escapeMarkdownV2(text), {
				parse_mode: "MarkdownV2",
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			// "message is not modified" is expected when text hasn't changed
			if (!msg.includes("message is not modified")) {
				console.warn(`[telegram] Failed to edit message: ${msg}`);
			}
		}
	}

	private registerHandlers(): void {
		if (!this.bot) return;

		// Owner /start authorizes this chat/topic for everyone in it.
		this.bot.command("start", async (ctx) => {
			const m = ctx.message;
			if (!m) return;
			const threadId = topicThreadId(m);
			if (this.isOwner(ctx.from?.id)) {
				this.setAuthorized(m.chat.id, threadId, true);
				console.log(`[telegram] Owner authorized ${placeKey(m.chat.id, threadId)}`);
				await this.replyHere(m.chat.id, threadId, "Authorized: anyone here can now talk to me. Send /revoke to undo.");
				return;
			}
			if (this.isAuthorized(m.chat.id, threadId)) {
				await this.replyHere(m.chat.id, threadId, "Hello! I'm Phantom. Send me a message to get started.");
				return;
			}
			console.warn(`[telegram] /start from non-owner ${ctx.from?.id ?? "unknown"} (@${ctx.from?.username ?? "-"})`);
			await this.replyHere(
				m.chat.id,
				threadId,
				`Not authorized. Your Telegram user ID is ${ctx.from?.id ?? "unknown"}.`,
			);
		});

		this.bot.command("revoke", async (ctx) => {
			const m = ctx.message;
			if (!m || !this.isOwner(ctx.from?.id)) return;
			const threadId = topicThreadId(m);
			this.setAuthorized(m.chat.id, threadId, false);
			console.log(`[telegram] Owner revoked ${placeKey(m.chat.id, threadId)}`);
			await this.replyHere(m.chat.id, threadId, "Revoked: only the owner can talk to me here now.");
		});

		this.bot.command("status", async (ctx) => {
			const m = ctx.message;
			if (!m || !this.canUse(ctx.from?.id, m.chat.id, topicThreadId(m))) return;
			await this.replyHere(m.chat.id, topicThreadId(m), "Phantom is running and ready to help.");
		});

		this.bot.command("help", async (ctx) => {
			const m = ctx.message;
			if (!m || !this.canUse(ctx.from?.id, m.chat.id, topicThreadId(m))) return;
			await ctx.reply(
				"Send me any message and I'll help you out.\n\nCommands:\n/start - Introduction (owner: authorize this topic)\n/revoke - Owner: remove authorization\n/status - Check status\n/help - Show this message",
				m.message_thread_id !== undefined && m.is_topic_message ? { message_thread_id: m.message_thread_id } : {},
			);
		});

		this.bot.on("text", async (ctx) => {
			if (!this.messageHandler || !ctx.message?.text) return;

			const text = ctx.message.text;
			// Skip commands (they're handled above)
			if (text.startsWith("/")) return;

			const chatId = ctx.message.chat.id;
			const from = ctx.message.from;
			const threadId = topicThreadId(ctx.message);
			if (!this.canUse(from?.id, chatId, threadId)) {
				console.warn(
					`[telegram] Ignored message from ${from?.id ?? "unknown"} in ${placeKey(chatId, threadId)} (not authorized)`,
				);
				return;
			}
			const conversationId = telegramConversationId(chatId, threadId);

			const inbound: InboundMessage = {
				id: String(ctx.message.message_id),
				channelId: this.id,
				conversationId,
				senderId: String(from?.id ?? "unknown"),
				senderName: from?.first_name ?? from?.username,
				text,
				timestamp: new Date(),
				metadata: {
					telegramChatId: chatId,
					telegramMessageId: ctx.message.message_id,
					...(threadId !== undefined ? { telegramThreadId: threadId } : {}),
				},
			};

			try {
				await this.messageHandler(inbound);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[telegram] Error handling message: ${msg}`);
			}
		});

		// Handle inline keyboard button presses
		this.bot.action(/^phantom:(.+)$/, async (ctx) => {
			if (ctx.answerCbQuery) {
				await ctx.answerCbQuery();
			}

			const data = ctx.match?.[1];
			if (!data || !this.messageHandler) return;

			const chatId = ctx.callbackQuery?.message?.chat.id;
			if (!chatId) return;

			const from = ctx.from;
			const threadId = ctx.callbackQuery?.message ? topicThreadId(ctx.callbackQuery.message) : undefined;
			if (!this.canUse(from?.id, chatId, threadId)) return;
			const conversationId = telegramConversationId(chatId, threadId);

			const inbound: InboundMessage = {
				id: `cb_${Date.now()}`,
				channelId: this.id,
				conversationId,
				senderId: String(from?.id ?? "unknown"),
				senderName: from?.first_name ?? from?.username,
				text: data,
				timestamp: new Date(),
				metadata: {
					telegramChatId: chatId,
					source: "callback_query",
					callbackData: data,
					...(threadId !== undefined ? { telegramThreadId: threadId } : {}),
				},
			};

			try {
				await this.messageHandler(inbound);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[telegram] Error handling callback: ${msg}`);
			}
		});
	}
}

/** Topic id of a forum-topic message; undefined for private chats, General and non-forum groups. */
function topicThreadId(message: { message_thread_id?: number; is_topic_message?: boolean }): number | undefined {
	return message.is_topic_message && message.message_thread_id !== undefined ? message.message_thread_id : undefined;
}

export function telegramConversationId(chatId: number, threadId?: number): string {
	return threadId !== undefined ? `telegram:${chatId}:${threadId}` : `telegram:${chatId}`;
}

export function parseTelegramConversationId(conversationId: string): { chatId: number; threadId?: number } {
	// Format: "telegram:{chat_id}" or "telegram:{chat_id}:{topic_id}"
	const [, chatId, threadId] = conversationId.split(":");
	return threadId ? { chatId: Number(chatId), threadId: Number(threadId) } : { chatId: Number(chatId) };
}

/** Accepts a list, a single id, or a comma-separated string (from ${TELEGRAM_OWNER_IDS}). */
export function parseTelegramOwnerIds(raw: string | number | Array<string | number> | null | undefined): number[] {
	if (raw === null || raw === undefined) return [];
	const parts = Array.isArray(raw) ? raw : String(raw).split(",");
	return parts.map((p) => Number(String(p).trim())).filter((n) => Number.isInteger(n) && n > 0);
}

function placeKey(chatId: number, threadId: number | undefined): string {
	return `${chatId}:${threadId ?? "main"}`;
}

function typingKey(chatId: number, threadId?: number): string {
	return threadId !== undefined ? `${chatId}:${threadId}` : String(chatId);
}

/**
 * Escape special characters for Telegram MarkdownV2.
 * Characters that need escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
function escapeMarkdownV2(text: string): string {
	// Preserve code blocks
	const codeBlocks: string[] = [];
	let result = text.replace(/```[\s\S]*?```/g, (match) => {
		codeBlocks.push(match);
		return `\x00CB${codeBlocks.length - 1}\x00`;
	});

	// Preserve inline code
	const inlineCodes: string[] = [];
	result = result.replace(/`[^`]+`/g, (match) => {
		inlineCodes.push(match);
		return `\x00IC${inlineCodes.length - 1}\x00`;
	});

	// Escape special characters outside of code
	result = result.replace(/([_*\[\]()~>#+\-=|{}.!\\])/g, "\\$1");

	// Restore inline code and code blocks
	for (let i = 0; i < inlineCodes.length; i++) {
		result = result.replace(`\x00IC${i}\x00`, inlineCodes[i]);
	}
	for (let i = 0; i < codeBlocks.length; i++) {
		result = result.replace(`\x00CB${i}\x00`, codeBlocks[i]);
	}

	return result;
}
