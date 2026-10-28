import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoCommands } from "../src/demo-commands.js";

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const command = (id = "one", remainingMs = 45_000) => ({
	id,
	name: "save_population",
	arguments: { source: { unknown: true } },
	remainingMs,
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
function harness(batches: unknown[] = []) {
	const fetcher = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
		if (url === "/api/demo/commands") return response({ commands: batches.shift() ?? [] });
		if (String(url).startsWith("/api/demo/commands/"))
			return response({ pending: true, remainingMs: 45_000 });
		return response({ ok: true });
	});
	const client = new DemoCommands(fetcher);
	const invoke = vi.fn(async () => ({ saved: true }));
	const events = vi.fn();
	const start = () => client.start({ token: "secret" }, invoke, events);
	return { client, fetcher, invoke, events, start };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
const requests = (h: ReturnType<typeof harness>, path: string) =>
	h.fetcher.mock.calls.filter(([url]) => url === path);

describe("DemoCommands CPU transport", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("binds the default browser fetch receiver", async () => {
		const native = vi.fn(function (this: unknown) {
			if (this !== globalThis) throw new TypeError("Illegal invocation");
			return Promise.resolve(response({ commands: [] }));
		});
		vi.stubGlobal("fetch", native);
		const client = new DemoCommands(),
			event = vi.fn();
		client.start({ token: "session" }, vi.fn(), event);
		await flush();
		expect(native).toHaveBeenCalledTimes(1);
		expect(event).not.toHaveBeenCalled();
		client.stop();
		await flush();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ignores a late old poll after reconnect and cancels with the captured old token", async () => {
		const h = harness();
		const late = deferred<Response>();
		h.fetcher.mockImplementationOnce(() => late.promise);
		const connection = { token: "old-secret" };
		h.client.start(connection, h.invoke, h.events);
		connection.token = "mutated";
		h.client.start({ token: "new-secret" }, h.invoke, h.events);
		late.resolve(response({ commands: [command()] }));
		await flush();
		expect(h.invoke).not.toHaveBeenCalled();
		expect(requests(h, "/api/demo/commands")[0]?.[1]?.signal?.aborted).toBe(true);
		expect(requests(h, "/api/demo/cancel")[0]?.[1]?.headers).toMatchObject({
			Authorization: "Bearer old-secret",
		});
		expect(JSON.stringify(h.events.mock.calls)).not.toContain("secret");
		h.client.stop();
		await flush();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stop during the first command prevents both its commit and the second command", async () => {
		const h = harness([[command(), command("two")]]);
		const late = deferred<void>();
		const mutations: string[] = [];
		let signal: AbortSignal | undefined;
		const invoke = vi.fn(
			async (name: string, _input: unknown, s: AbortSignal, guard: () => Promise<void>) => {
				signal = s;
				await late.promise;
				await guard();
				mutations.push(name);
			},
		);
		h.client.start({ token: "secret" }, invoke, h.events);
		await flush();
		h.client.stop();
		late.resolve();
		await flush();
		expect(signal?.aborted).toBe(true);
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(mutations).toEqual([]);
		expect(requests(h, "/api/demo/results")).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("backend expiry aborts long analysis before its mutation guard", async () => {
		const h = harness([[command()]]);
		const late = deferred<void>();
		let signal: AbortSignal | undefined;
		let mutated = false;
		h.client.start(
			{ token: "secret" },
			async (_name, _input, s, guard) => {
				signal = s;
				await late.promise;
				await guard();
				mutated = true;
			},
			h.events,
		);
		await flush();
		h.fetcher.mockResolvedValueOnce(response({}, 404));
		await vi.advanceTimersByTimeAsync(750);
		expect(signal?.aborted).toBe(true);
		late.resolve();
		await flush();
		expect(mutated).toBe(false);
		expect(requests(h, "/api/demo/results")).toHaveLength(0);
		h.client.stop();
		await flush();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([404, 500, 401, 403])(
		"never reports completion for rejected results (%s)",
		async (status) => {
			const h = harness([[command()]]);
			const original = h.fetcher.getMockImplementation();
			h.fetcher.mockImplementation(async (url, init) =>
				url === "/api/demo/results"
					? response({}, status)
					: (original?.(url, init) as Promise<Response>),
			);
			h.start();
			await flush();
			expect(h.invoke).toHaveBeenCalledTimes(1);
			expect(h.events.mock.calls.some(([event]) => event.type === "tool-result")).toBe(false);
			if (status === 401 || status === 403) {
				await vi.advanceTimersByTimeAsync(10_000);
				expect(requests(h, "/api/demo/commands")).toHaveLength(1);
			}
			h.client.stop();
			await flush();
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("keeps one poll in flight over multiple rounds and passes inputs unchanged", async () => {
		const h = harness([[command()], [], [command("three")]]);
		h.start();
		await flush();
		await vi.advanceTimersByTimeAsync(1_500);
		expect(requests(h, "/api/demo/commands")).toHaveLength(3);
		expect(h.invoke).toHaveBeenCalledTimes(2);
		expect(h.invoke.mock.calls[0]).toEqual([
			"save_population",
			command().arguments,
			expect.any(AbortSignal),
			expect.any(Function),
		]);
		const late = deferred<Response>();
		h.fetcher.mockImplementationOnce(() => late.promise);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(requests(h, "/api/demo/commands")).toHaveLength(4);
		h.client.stop();
		late.resolve(response({ commands: [] }));
		await flush();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not overlap pending checks and enforces the original batch deadline", async () => {
		const h = harness([[command("one", 1_000), command("two", 1_000)]]);
		let signal: AbortSignal | undefined;
		h.client.start(
			{ token: "secret" },
			async (_name, _input, s) => {
				signal = s;
				return new Promise(() => {});
			},
			h.events,
		);
		await flush();
		const late = deferred<Response>();
		h.fetcher.mockImplementationOnce(() => late.promise);
		await vi.advanceTimersByTimeAsync(999);
		expect(requests(h, "/api/demo/commands/one")).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(signal?.aborted).toBe(true);
		expect(requests(h, "/api/demo/commands/two")).toHaveLength(0);
		h.client.stop();
		late.resolve(response({ pending: true, remainingMs: 45_000 }));
		await flush();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([401, 403])("stops polling on expired connection (%s)", async (status) => {
		const h = harness();
		h.fetcher.mockResolvedValueOnce(response({}, status));
		h.start();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(requests(h, "/api/demo/commands")).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("caps command lifetime at 45 seconds even when the backend advertises longer", async () => {
		const h = harness([[command("one", 90_000)]]);
		let signal: AbortSignal | undefined;
		h.client.start(
			{ token: "secret" },
			async (_name, _input, s) => {
				signal = s;
				return new Promise(() => {});
			},
			h.events,
		);
		await vi.advanceTimersByTimeAsync(44_999);
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(signal?.aborted).toBe(true);
		h.client.stop();
		await flush();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not overlap slow pending checks or report an old result after reconnect", async () => {
		const h = harness([[command()]]);
		const work = deferred<void>();
		h.client.start({ token: "secret" }, () => work.promise, h.events);
		await flush();
		const check = deferred<Response>();
		h.fetcher.mockImplementationOnce(() => check.promise);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(requests(h, "/api/demo/commands/one")).toHaveLength(2);
		check.resolve(response({ pending: true, remainingMs: 40_000 }));
		await flush();
		const result = deferred<Response>();
		const original = h.fetcher.getMockImplementation();
		h.fetcher.mockImplementation(async (url, init) =>
			url === "/api/demo/results" ? result.promise : (original?.(url, init) as Promise<Response>),
		);
		work.resolve();
		await flush();
		expect(requests(h, "/api/demo/results")).toHaveLength(1);
		h.client.start({ token: "new-secret" }, h.invoke, h.events);
		result.resolve(response({ ok: true }));
		await flush();
		expect(h.events.mock.calls.some(([event]) => event.type === "tool-result")).toBe(false);
		h.client.stop();
		await flush();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		Array.from({ length: 9 }, (_, i) => command(String(i))),
		[command("bad/id")],
		[{ ...command(), name: "x".repeat(129) }],
		[command(), command()],
		[command("one", -1)],
	])("rejects malformed or oversized batches before invoking anything", async (batch) => {
		const h = harness([batch]);
		h.start();
		await flush();
		expect(h.invoke).not.toHaveBeenCalled();
		h.client.stop();
		await flush();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("bounds best-effort cancellation to five seconds even if fetch never settles", async () => {
		const h = harness();
		h.start();
		await flush();
		h.fetcher.mockImplementationOnce(() => new Promise(() => {}));
		h.client.stop();
		await flush();
		const signal = requests(h, "/api/demo/cancel")[0]?.[1]?.signal;
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});
