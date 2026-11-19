import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	TelegramChannel,
	type TelegramChannelConfig,
	parseTelegramConversationId,
	parseTelegramOwnerIds,
} from "../telegram.ts";

// Mock Telegraf
// Like Telegraf >= 4.16: onLaunch fires after getMe, the promise settles only when polling stops.
const mockLaunch = mock((onLaunch?: () => void) => {
	onLaunch?.();
	return new Promise<void>(() => {});
});
const mockStop = mock(() => {});
const mockSendMessage = mock(async (_chatId: number | string, _text: string, _opts?: Record<string, unknown>) => ({
	message_id: 42,
}));
const mockEditMessageText = mock(
	async (
		_chatId: number | string,
		_msgId: number,
		_inlineMsgId: string | undefined,
		_text: string,
		_opts?: Record<string, unknown>,
	) => ({}),
);
const mockSendChatAction = mock(async (_chatId: number | string, _action: string) => {});

type HandlerFn = (ctx: Record<string, unknown>) => Promise<void>;
const commandHandlers = new Map<string, HandlerFn>();
const eventHandlers = new Map<string, HandlerFn>();
const actionPatterns: Array<{ pattern: RegExp; handler: HandlerFn }> = [];

const MockTelegraf = mock((_token: string) => ({
	launch: mockLaunch,
	stop: mockStop,
	command: (cmd: string, handler: HandlerFn) => {
		commandHandlers.set(cmd, handler);
	},
	on: (event: string, handler: HandlerFn) => {
		eventHandlers.set(event, handler);
	},
	action: (pattern: RegExp, handler: HandlerFn) => {
		actionPatterns.push({ pattern, handler });
	},
	telegram: {
		sendMessage: mockSendMessage,
		editMessageText: mockEditMessageText,
		sendChatAction: mockSendChatAction,
	},
}));

mock.module("telegraf", () => ({
	Telegraf: MockTelegraf,
}));

const testConfig: TelegramChannelConfig = {
	botToken: "123456:ABC-DEF",
	ownerIds: [12345],
};

describe("TelegramChannel", () => {
	beforeEach(() => {
		commandHandlers.clear();
		eventHandlers.clear();
		actionPatterns.length = 0;
		mockLaunch.mockClear();
		mockStop.mockClear();
		mockSendMessage.mockClear();
		mockEditMessageText.mockClear();
		mockSendChatAction.mockClear();
	});

	test("has correct id and capabilities", () => {
		const channel = new TelegramChannel(testConfig);
		expect(channel.id).toBe("telegram");
		expect(channel.name).toBe("Telegram");
		expect(channel.capabilities.inlineKeyboards).toBe(true);
		expect(channel.capabilities.typing).toBe(true);
		expect(channel.capabilities.messageEditing).toBe(true);
	});

	test("starts disconnected", () => {
		const channel = new TelegramChannel(testConfig);
		expect(channel.isConnected()).toBe(false);
	});

	test("connect transitions to connected", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();
		expect(channel.isConnected()).toBe(true);
		expect(mockLaunch).toHaveBeenCalledTimes(1);
	});

	test("connect resolves on onLaunch even though launch() never settles", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();
		expect(channel.getConnectionState()).toBe("connected");
	});

	test("connect rejects when the token is refused before launch", async () => {
		mockLaunch.mockImplementationOnce(() => Promise.reject(new Error("401: Unauthorized")));
		const channel = new TelegramChannel(testConfig);
		await expect(channel.connect()).rejects.toThrow("401");
		expect(channel.getConnectionState()).toBe("error");
	});

	test("reconnects after polling dies (e.g. ECONNRESET)", async () => {
		let failPolling: (err: Error) => void = () => {};
		mockLaunch.mockImplementationOnce((onLaunch?: () => void) => {
			onLaunch?.();
			return new Promise<void>((_, reject) => {
				failPolling = reject;
			});
		});
		const channel = new TelegramChannel({ ...testConfig, reconnectBaseMs: 10 });
		await channel.connect();
		const launchesBefore = mockLaunch.mock.calls.length;

		failPolling(new Error("ECONNRESET"));
		await new Promise((r) => setTimeout(r, 0));
		expect(channel.getConnectionState()).toBe("error");

		await new Promise((r) => setTimeout(r, 50));
		expect(mockLaunch.mock.calls.length).toBe(launchesBefore + 1);
		expect(channel.getConnectionState()).toBe("connected");
		await channel.disconnect();
	});

	test("no reconnect after disconnect", async () => {
		let failPolling: (err: Error) => void = () => {};
		mockLaunch.mockImplementationOnce((onLaunch?: () => void) => {
			onLaunch?.();
			return new Promise<void>((_, reject) => {
				failPolling = reject;
			});
		});
		const channel = new TelegramChannel({ ...testConfig, reconnectBaseMs: 10 });
		await channel.connect();
		await channel.disconnect();
		const launchesBefore = mockLaunch.mock.calls.length;
		failPolling(new Error("stopped"));
		await new Promise((r) => setTimeout(r, 50));
		expect(mockLaunch.mock.calls.length).toBe(launchesBefore);
		expect(channel.getConnectionState()).toBe("disconnected");
	});

	test("disconnect transitions to disconnected", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();
		await channel.disconnect();
		expect(channel.isConnected()).toBe(false);
	});

	test("registers command handlers on connect", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();
		expect(commandHandlers.has("start")).toBe(true);
		expect(commandHandlers.has("status")).toBe(true);
		expect(commandHandlers.has("help")).toBe(true);
	});

	test("registers text handler on connect", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();
		expect(eventHandlers.has("text")).toBe(true);
	});

	test("routes text messages to handler", async () => {
		const channel = new TelegramChannel(testConfig);
		let receivedText = "";

		channel.onMessage(async (msg) => {
			receivedText = msg.text;
		});

		await channel.connect();

		const textHandler = eventHandlers.get("text");
		expect(textHandler).toBeDefined();
		if (textHandler) {
			await textHandler({
				message: {
					text: "Hello Phantom",
					from: { id: 12345, first_name: "Test" },
					chat: { id: 67890 },
					message_id: 1,
				},
			});
		}

		expect(receivedText).toBe("Hello Phantom");
	});

	test("ignores slash commands in text handler", async () => {
		const channel = new TelegramChannel(testConfig);
		let handlerCalled = false;

		channel.onMessage(async () => {
			handlerCalled = true;
		});

		await channel.connect();

		const textHandler = eventHandlers.get("text");
		if (textHandler) {
			await textHandler({
				message: {
					text: "/start",
					from: { id: 12345 },
					chat: { id: 67890 },
					message_id: 1,
				},
			});
		}

		expect(handlerCalled).toBe(false);
	});

	test("sends message via send method", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();

		const result = await channel.send("telegram:67890", { text: "Hello" });
		expect(result.channelId).toBe("telegram");
		expect(result.id).toBe("42");
		expect(mockSendMessage).toHaveBeenCalledTimes(1);
	});

	test("startTyping sends chat action and sets interval", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();

		channel.startTyping(67890);
		expect(mockSendChatAction).toHaveBeenCalledWith(67890, "typing");

		channel.stopTyping(67890);
	});

	test("stopTyping clears the typing interval", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();

		channel.startTyping(67890);
		channel.stopTyping(67890);

		// The interval fires every 4s. Wait 4.5s to confirm it was cleared.
		// Use a shorter wait than the old 5s to stay within bun's test timeout.
		mockSendChatAction.mockClear();
		await new Promise((r) => setTimeout(r, 4500));
		expect(mockSendChatAction).not.toHaveBeenCalled();
	}, 10000);

	test("editMessage calls telegram API", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();

		await channel.editMessage(67890, 42, "Updated text");
		expect(mockEditMessageText).toHaveBeenCalledTimes(1);
	});
});

describe("TelegramChannel forum topics and owner check", () => {
	beforeEach(() => {
		commandHandlers.clear();
		eventHandlers.clear();
		actionPatterns.length = 0;
		mockSendMessage.mockClear();
		mockSendChatAction.mockClear();
	});

	async function deliver(
		channel: TelegramChannel,
		message: Record<string, unknown>,
	): Promise<Array<{ conversationId: string; metadata?: Record<string, unknown> }>> {
		const received: Array<{ conversationId: string; metadata?: Record<string, unknown> }> = [];
		channel.onMessage(async (msg) => {
			received.push({ conversationId: msg.conversationId, metadata: msg.metadata });
		});
		await channel.connect();
		await eventHandlers.get("text")?.({ message });
		return received;
	}

	test("a forum topic message gets its own conversation id", async () => {
		const received = await deliver(new TelegramChannel(testConfig), {
			text: "hi",
			from: { id: 12345 },
			chat: { id: -1001 },
			message_id: 7,
			message_thread_id: 55,
			is_topic_message: true,
		});
		expect(received).toHaveLength(1);
		expect(received[0].conversationId).toBe("telegram:-1001:55");
		expect(received[0].metadata?.telegramThreadId).toBe(55);
	});

	test("General topic and reply threads in plain groups stay on the chat id", async () => {
		const received = await deliver(new TelegramChannel(testConfig), {
			text: "hi",
			from: { id: 12345 },
			chat: { id: -1001 },
			message_id: 8,
			message_thread_id: 3,
		});
		expect(received[0].conversationId).toBe("telegram:-1001");
		expect(received[0].metadata?.telegramThreadId).toBeUndefined();
	});

	test("messages from non-owners are dropped", async () => {
		const received = await deliver(new TelegramChannel(testConfig), {
			text: "let me in",
			from: { id: 999 },
			chat: { id: 999 },
			message_id: 9,
		});
		expect(received).toHaveLength(0);
	});

	test("no owner ids configured means nobody is answered", async () => {
		const received = await deliver(new TelegramChannel({ botToken: "x:y" }), {
			text: "hi",
			from: { id: 12345 },
			chat: { id: 12345 },
			message_id: 10,
		});
		expect(received).toHaveLength(0);
	});

	test("/start tells a non-owner their user id and nothing else", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();
		await commandHandlers.get("start")?.({
			from: { id: 999 },
			message: { text: "/start", from: { id: 999 }, chat: { id: 999 }, message_id: 1 },
		});
		expect(mockSendMessage.mock.calls[0][1]).toBe("Not authorized. Your Telegram user ID is 999.");
		expect(channel.isAuthorized(999, undefined)).toBe(false);
	});

	test("send() into a topic passes message_thread_id", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();
		await channel.send("telegram:-1001:55", { text: "Hello" });
		expect(mockSendMessage.mock.calls[0][0]).toBe(-1001);
		expect(mockSendMessage.mock.calls[0][2]).toMatchObject({ message_thread_id: 55 });
	});

	test("send() to a plain chat has no message_thread_id", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();
		await channel.send("telegram:67890", { text: "Hello" });
		expect(mockSendMessage.mock.calls[0][2]).not.toHaveProperty("message_thread_id");
	});

	test("typing inside a topic targets the topic", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();
		channel.startTyping(-1001, 55);
		expect(mockSendChatAction).toHaveBeenCalledWith(-1001, "typing", { message_thread_id: 55 });
		channel.stopTyping(-1001, 55);
	});

	test("parseTelegramConversationId handles both forms", () => {
		expect(parseTelegramConversationId("telegram:67890")).toEqual({ chatId: 67890 });
		expect(parseTelegramConversationId("telegram:-1001:55")).toEqual({ chatId: -1001, threadId: 55 });
	});

	test("parseTelegramOwnerIds accepts lists, numbers and comma strings", () => {
		expect(parseTelegramOwnerIds("111, 222")).toEqual([111, 222]);
		expect(parseTelegramOwnerIds(333)).toEqual([333]);
		expect(parseTelegramOwnerIds(["444", 555])).toEqual([444, 555]);
		expect(parseTelegramOwnerIds("")).toEqual([]);
		expect(parseTelegramOwnerIds(null)).toEqual([]);
		expect(parseTelegramOwnerIds("abc")).toEqual([]);
	});
});

describe("TelegramChannel owner /start authorizes a topic for everyone", () => {
	const file = `/tmp/phantom-auth-test-${process.pid}.json`;

	beforeEach(async () => {
		commandHandlers.clear();
		eventHandlers.clear();
		actionPatterns.length = 0;
		mockSendMessage.mockClear();
		const { rmSync } = await import("node:fs");
		rmSync(file, { force: true });
	});

	const msg = (from: number, thread?: number, text = "hi") => ({
		text,
		from: { id: from },
		chat: { id: -1001 },
		message_id: 1,
		...(thread !== undefined ? { message_thread_id: thread, is_topic_message: true } : {}),
	});

	async function setup() {
		const channel = new TelegramChannel({ ...testConfig, authFile: file });
		const received: Array<{ conversationId: string; senderId: string }> = [];
		channel.onMessage(async (m) => {
			received.push({ conversationId: m.conversationId, senderId: m.senderId });
		});
		await channel.connect();
		return { channel, received };
	}

	test("before /start, a non-owner in a topic is ignored", async () => {
		const { received } = await setup();
		await eventHandlers.get("text")?.({ message: msg(999, 55) });
		expect(received).toHaveLength(0);
	});

	test("owner /start in a topic lets anyone there talk, replies land in that topic", async () => {
		const { channel, received } = await setup();
		await commandHandlers.get("start")?.({ from: { id: 12345 }, message: msg(12345, 55, "/start") });
		expect(channel.isAuthorized(-1001, 55)).toBe(true);
		expect(mockSendMessage.mock.calls[0][2]).toMatchObject({ message_thread_id: 55 });

		await eventHandlers.get("text")?.({ message: msg(999, 55) });
		expect(received).toEqual([{ conversationId: "telegram:-1001:55", senderId: "999" }]);
	});

	test("authorizing one topic does not open another topic or General", async () => {
		const { received } = await setup();
		await commandHandlers.get("start")?.({ from: { id: 12345 }, message: msg(12345, 55, "/start") });
		await eventHandlers.get("text")?.({ message: msg(999, 66) });
		await eventHandlers.get("text")?.({ message: msg(999) });
		expect(received).toHaveLength(0);
	});

	test("a non-owner /start cannot authorize anything", async () => {
		const { channel } = await setup();
		await commandHandlers.get("start")?.({ from: { id: 999 }, message: msg(999, 55, "/start") });
		expect(channel.isAuthorized(-1001, 55)).toBe(false);
	});

	test("authorization survives a restart; owner /revoke removes it, non-owner /revoke does nothing", async () => {
		const { channel } = await setup();
		await commandHandlers.get("start")?.({ from: { id: 12345 }, message: msg(12345, 55, "/start") });
		expect(new TelegramChannel({ ...testConfig, authFile: file }).isAuthorized(-1001, 55)).toBe(true);

		await commandHandlers.get("revoke")?.({ from: { id: 999 }, message: msg(999, 55, "/revoke") });
		expect(channel.isAuthorized(-1001, 55)).toBe(true);
		await commandHandlers.get("revoke")?.({ from: { id: 12345 }, message: msg(12345, 55, "/revoke") });
		expect(channel.isAuthorized(-1001, 55)).toBe(false);
		expect(new TelegramChannel({ ...testConfig, authFile: file }).isAuthorized(-1001, 55)).toBe(false);
	});

	test("the owner is answered everywhere without /start", async () => {
		const { received } = await setup();
		await eventHandlers.get("text")?.({ message: msg(12345, 77) });
		expect(received).toHaveLength(1);
	});
});
