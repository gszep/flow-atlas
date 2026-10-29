import { describe, expect, it, vi } from "vitest";
import { AGENT_EVENT_TEXT_LIMIT, type AgentEvent, DemoAgent } from "../src/demo-agent.js";
import { DemoToolError } from "../src/demo-tool-errors.js";

const done = (text = "Finished") => ({
	stop_reason: "end_turn",
	content: [{ type: "text", text }],
});
const tool = (id = "call-1", name = "inspect_dataset") => ({
	type: "tool_use",
	id,
	name,
	input: { expectedRevision: 3 },
});
const use = (...content: unknown[]) => ({ stop_reason: "tool_use", content });
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
function harness(replies: unknown[]) {
	const requests: RequestInit[] = [];
	const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		if (url === "/api/demo/config")
			return response({
				agentConfigured: true,
				speechConfigured: false,
				model: "configured-model",
			});
		if (url === "/api/demo/session")
			return response({ token: "private-session-token", expiresAt: 12345 });
		requests.push(init ?? {});
		const next = replies.shift();
		return next instanceof Promise ? await next : response(next);
	});
	const agent = new DemoAgent(fetcher);
	const events: AgentEvent[] = [];
	const onEvent = (event: AgentEvent) => {
		events.push(event);
	};
	const invoke = vi.fn(async () => ({ count: 42 }));
	return { agent, requests, events, onEvent, invoke, fetcher };
}
const body = (request: RequestInit | undefined) => JSON.parse(String(request?.body));

describe("DemoAgent CPU transport", () => {
	it("renews an expired guest session once without repeating tool execution", async () => {
		let sessions = 0,
			calls = 0;
		const fetcher = vi.fn(async (url: string | URL | Request) => {
			if (url === "/api/demo/session")
				return response({ token: `guest-${++sessions}`, expiresAt: Date.now() + 60000 });
			calls++;
			return calls === 1 ? new Response("{}", { status: 401 }) : response(done("ready"));
		});
		const agent = new DemoAgent(fetcher),
			invoke = vi.fn();
		await agent.connect();
		await agent.ask("inspect", {}, invoke, vi.fn());
		expect(sessions).toBe(2);
		expect(calls).toBe(2);
		expect(invoke).not.toHaveBeenCalled();
		expect(agent.connection()?.token).toBe("guest-2");
	});
	it("opens a guest session without sending an access code", async () => {
		const h = harness([]);
		await h.agent.connect();
		const request = h.fetcher.mock.calls.find(([url]) => url === "/api/demo/session");
		expect(JSON.parse(String(request?.[1]?.body))).toEqual({});
	});
	it("returns actionable lookup errors to the model instead of an opaque failure", async () => {
		const h = harness([use(tool("bad", "inspect_population")), done()]);
		await h.agent.connect();
		h.invoke.mockRejectedValueOnce(
			new DemoToolError("population_not_found", "Use ref:20 for the imported EMRA reference", {
				id: "ref:20",
			}),
		);
		await h.agent.ask("inspect references", {}, h.invoke, h.onEvent);
		const next = body(h.requests[1]);
		const result = next.messages.at(-1).content[0];
		expect(result.is_error).toBe(true);
		expect(JSON.parse(result.content).error.code).toBe("population_not_found");
		expect(result.content).toContain("ref:20");
	});
	it("bounds a stalled connection and never admits its late token", async () => {
		vi.useFakeTimers();
		try {
			const late = deferred<Response>(),
				agent = new DemoAgent(vi.fn(() => late.promise));
			const pending = agent.connect("code").catch((error) => error);
			await vi.advanceTimersByTimeAsync(10000);
			expect(await pending).toBeInstanceOf(Error);
			late.resolve(response({ token: "late", expiresAt: 12345 }));
			await vi.advanceTimersByTimeAsync(0);
			expect(agent.connected).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
	it("bounds stalled revocation while clearing the local connection immediately", async () => {
		vi.useFakeTimers();
		try {
			const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
				init?.method === "DELETE"
					? new Promise<Response>(() => {})
					: response({ token: "session", expiresAt: 12345 }),
			);
			const agent = new DemoAgent(fetcher);
			await agent.connect("code");
			const pending = agent.disconnect().catch((error) => error);
			expect(agent.connected).toBe(false);
			await vi.advanceTimersByTimeAsync(10000);
			expect(await pending).toBeInstanceOf(Error);
		} finally {
			vi.useRealTimers();
		}
	});
	it("rejects a late connection after disconnect", async () => {
		const late = deferred<Response>();
		const agent = new DemoAgent(vi.fn(() => late.promise));
		const pending = agent.connect("code");
		await agent.disconnect();
		late.resolve(response({ token: "late-token", expiresAt: 12345 }));
		await expect(pending).rejects.toThrow("cancelled");
		expect(agent.connection()).toBeNull();
	});

	it("bounds message count by removing complete prior turns", async () => {
		const h = harness(Array.from({ length: 20 }, () => done()));
		await h.agent.connect("code");
		for (let i = 0; i < 20; i++) await h.agent.ask(`turn-${i}`, {}, h.invoke, h.onEvent);
		const messages = body(h.requests.at(-1)).messages;
		expect(messages.length).toBeLessThanOrEqual(32);
		expect(messages[0].role).toBe("user");
		expect(messages.at(-1).role).toBe("user");
		expect(JSON.parse(messages[0].content[0].text).request).not.toBe("turn-0");
	});

	it("sanitizes network errors and never retries a failed request", async () => {
		const h = harness([]);
		await h.agent.connect("code");
		h.fetcher.mockRejectedValueOnce(new Error("private credentials and browser details"));
		await expect(h.agent.ask("inspect", {}, h.invoke, h.onEvent)).rejects.toThrow(
			"Agent request failed.",
		);
		expect(h.fetcher).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(h.events)).not.toContain("credentials");
	});
	it("connects in memory and sends exact ordered Claude tool results", async () => {
		const h = harness([
			use({ type: "text", text: "Inspecting" }, tool(), tool("call-2", "list_populations")),
			done(),
		]);
		expect(await h.agent.config()).toEqual({
			agentConfigured: true,
			speechConfigured: false,
			model: "configured-model",
		});
		await h.agent.connect("code");
		const connection = h.agent.connection();
		if (connection) connection.token = "mutated";
		await h.agent.ask("Inspect dataset", { selected: "human-selection" }, h.invoke, h.onEvent);
		expect(h.requests[0]?.headers).toMatchObject({ Authorization: "Bearer private-session-token" });
		expect(body(h.requests[0]).messages).toEqual([
			{
				role: "user",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							context: { selected: "human-selection" },
							request: "Inspect dataset",
						}),
					},
				],
			},
		]);
		expect(body(h.requests[1]).messages.slice(1)).toEqual([
			{
				role: "assistant",
				content: [{ type: "text", text: "Inspecting" }, tool(), tool("call-2", "list_populations")],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call-1", content: '{"count":42}' },
					{ type: "tool_result", tool_use_id: "call-2", content: '{"count":42}' },
				],
			},
		]);
		expect(h.invoke).toHaveBeenCalledTimes(2);
		expect(h.invoke.mock.calls[0]).toEqual([
			"inspect_dataset",
			{ expectedRevision: 3 },
			expect.any(AbortSignal),
		]);
		expect(h.events.filter((e) => e.type === "text").map((e) => e.text)).toEqual([
			"Inspecting",
			"Finished",
		]);
	});

	it("cancels a late fetch without invoking tools or committing stale history", async () => {
		const late = deferred<Response>();
		const h = harness([late.promise, done()]);
		await h.agent.connect("code");
		const pending = h.agent.ask("first", {}, h.invoke, h.onEvent);
		h.agent.cancel();
		expect(h.requests[0]?.signal?.aborted).toBe(true);
		late.resolve(response(use(tool())));
		await pending;
		expect(h.invoke).not.toHaveBeenCalled();
		await h.agent.ask("second", {}, h.invoke, h.onEvent);
		expect(body(h.requests[1]).messages).toHaveLength(1);
	});

	it("guards cancellation while reading the response body", async () => {
		const json = deferred<unknown>();
		const h = harness([Promise.resolve({ ok: true, json: () => json.promise } as Response)]);
		await h.agent.connect("code");
		const pending = h.agent.ask("first", {}, h.invoke, h.onEvent);
		await Promise.resolve();
		h.agent.reset();
		json.resolve(use(tool()));
		await pending;
		expect(h.invoke).not.toHaveBeenCalled();
	});

	it("aborts an active tool and never executes the following tool", async () => {
		const entered = deferred<AbortSignal>();
		const late = deferred<unknown>();
		const h = harness([use(tool(), tool("second")), done()]);
		const invoke = vi.fn(async (_name: string, _input: unknown, signal: AbortSignal) => {
			entered.resolve(signal);
			return late.promise;
		});
		await h.agent.connect("code");
		const pending = h.agent.ask("inspect", {}, invoke, h.onEvent);
		const signal = await entered.promise;
		h.agent.reset();
		expect(signal.aborted).toBe(true);
		await expect(h.agent.ask("overlap", {}, invoke, h.onEvent)).rejects.toThrow("busy");
		late.resolve({ count: 7 });
		await pending;
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(h.events.some((e) => e.type === "tool-result")).toBe(false);
		await h.agent.ask("new", {}, invoke, h.onEvent);
		expect(body(h.requests[1]).messages).toHaveLength(1);
	});

	it("clears completed history on reset and disconnect, and revokes with bearer only", async () => {
		const h = harness([done(), done(), done(), done()]);
		await h.agent.connect("code");
		await h.agent.ask("one", {}, h.invoke, h.onEvent);
		await h.agent.ask("two", {}, h.invoke, h.onEvent);
		expect(body(h.requests[1]).messages).toHaveLength(3);
		h.agent.reset();
		await h.agent.ask("three", {}, h.invoke, h.onEvent);
		expect(body(h.requests[2]).messages).toHaveLength(1);
		await h.agent.disconnect();
		expect(h.agent.connection()).toBeNull();
		expect(h.agent.connected).toBe(false);
		expect(h.fetcher).toHaveBeenLastCalledWith(
			"/api/demo/session",
			expect.objectContaining({
				method: "DELETE",
				headers: { Authorization: "Bearer private-session-token" },
			}),
		);
		await h.agent.connect("new-code");
		await h.agent.ask("four", {}, h.invoke, h.onEvent);
		expect(body(h.requests[3]).messages).toHaveLength(1);
	});

	it.each([
		{ ...use(tool()), stop_reason: "max_tokens" },
		{ ...use(tool()), stop_reason: "refusal" },
		{ ...use(tool()), stop_reason: "pause_turn" },
		{ ...use(tool()), stop_reason: "end_turn" },
		use(tool(), { type: "tool_use", id: "bad", name: "not_allowed", input: {} }),
		use(tool(), tool()),
		use({ type: "tool_use", id: "missing-input", name: "inspect_dataset" }),
		use({ type: "thinking", thinking: "must not surface" }, tool()),
		{ stop_reason: "tool_use", content: [] },
		null,
	])("rejects the entire malformed/incomplete response before side effects: %j", async (reply) => {
		const h = harness([reply]);
		await h.agent.connect("code");
		await expect(h.agent.ask("inspect", {}, h.invoke, h.onEvent)).rejects.toThrow();
		expect(h.invoke).not.toHaveBeenCalled();
		expect(h.events.some((e) => e.type === "text")).toBe(false);
	});

	it("bounds tools per ask and model rounds without retries", async () => {
		const h = harness([
			use(...Array.from({ length: 24 }, (_, i) => tool(`id-${i}`))),
			use(tool("extra")),
		]);
		await h.agent.connect("code");
		await expect(h.agent.ask("inspect", {}, h.invoke, h.onEvent)).rejects.toThrow("budget");
		expect(h.invoke).toHaveBeenCalledTimes(24);
		expect(h.requests).toHaveLength(2);
		const rounds = harness(Array.from({ length: 12 }, (_, i) => use(tool(`round-${i}`))));
		await rounds.agent.connect("code");
		await expect(rounds.agent.ask("inspect", {}, rounds.invoke, rounds.onEvent)).rejects.toThrow(
			"budget",
		);
		expect(rounds.requests).toHaveLength(12);
		expect(rounds.invoke).toHaveBeenCalledTimes(11);
	});

	it("sanitizes private exceptions and bounds tool results in UTF-8 bytes", async () => {
		const h = harness([use(tool(), tool("big")), done("x".repeat(5000))]);
		await h.agent.connect("code");
		const invoke = vi
			.fn()
			.mockRejectedValueOnce(new Error("credential private-token browser path"))
			.mockResolvedValueOnce("🔥".repeat(7000));
		await h.agent.ask("inspect", {}, invoke, h.onEvent);
		const results = body(h.requests[1]).messages[2].content;
		expect(results.map((r: { is_error: boolean }) => r.is_error)).toEqual([true, true]);
		expect(JSON.stringify(h.events)).not.toContain("private-token");
		expect(JSON.stringify(h.requests)).not.toContain("browser path");
		expect(h.events.every((e) => e.text.length <= AGENT_EVENT_TEXT_LIMIT)).toBe(true);
	});

	it("trims whole completed turns including their tool exchanges", async () => {
		const h = harness([
			use(tool()),
			done("a".repeat(60000)),
			done("b".repeat(60000)),
			done("c".repeat(60000)),
			done(),
		]);
		await h.agent.connect("code");
		for (const text of ["first", "second", "third", "fourth"])
			await h.agent.ask(text, {}, h.invoke, h.onEvent);
		const last = body(h.requests.at(-1)).messages;
		expect(last).toHaveLength(5);
		expect(JSON.stringify(last)).not.toContain("call-1");
		expect(JSON.parse(last[0].content[0].text).request).toBe("second");
		expect(
			h.requests.every(
				(r) => new TextEncoder().encode(JSON.stringify(body(r).messages)).length <= 120 * 1024,
			),
		).toBe(true);
	});

	it("rejects oversize input/response before tools and validates requests", async () => {
		const h = harness([use(tool(), { type: "text", text: "x".repeat(123000) })]);
		await expect(h.agent.ask("hi", {}, h.invoke, h.onEvent)).rejects.toThrow("Connect");
		await h.agent.connect("code");
		for (const text of [" ", "x".repeat(4001)])
			await expect(h.agent.ask(text, {}, h.invoke, h.onEvent)).rejects.toThrow("characters");
		await expect(h.agent.ask("hi", "x".repeat(123000), h.invoke, h.onEvent)).rejects.toThrow(
			"size limit",
		);
		expect(h.requests).toHaveLength(0);
		await expect(h.agent.ask("hi", {}, h.invoke, h.onEvent)).rejects.toThrow("size limit");
		expect(h.invoke).not.toHaveBeenCalled();
	});
});
