import { describe, expect, it, vi } from "vitest";
import {
	BROWSER_CACHE_DATABASE,
	BROWSER_CACHE_SCHEMA_VERSION,
	BROWSER_CACHE_STORE,
	browserCache,
	createBrowserCache,
} from "../src/browser-cache.js";

/** Minimal in-memory IDBFactory fake: open/one store/get/put/delete/cursor only.
 * Deliberately not a full IDB framework — just enough for the cache contract. */
function fakeFactory(
	options: {
		unavailable?: boolean;
		failTransactions?: boolean;
		quota?: boolean;
		delayMs?: number;
	} = {},
) {
	const databases = new Map<string, Map<string, unknown>>();
	const instance = {
		cmp: (a: unknown, b: unknown) => (a === b ? 0 : String(a) < String(b) ? -1 : 1),
		databases: async () => [...databases.keys()].map((name) => ({ name, version: 1 })),
		deleteDatabase: () => eventual({ onsuccess: null, onerror: null, onblocked: null }),
		open(name: string) {
			const request = eventual<unknown>({
				onsuccess: null,
				onerror: null,
				onupgradeneeded: null,
				onblocked: null,
				result: null,
				readyState: "pending",
			});
			if (options.unavailable) {
				setTimeout(() => {
					const error = new Error("IndexedDB unavailable");
					request.onerror?.({ target: { error } } as unknown as Event);
				}, 0);
				return request;
			}
			setTimeout(() => {
				let database = databases.get(name);
				const upgrade = !database
					? {
							objectStoreNames: { contains: () => false },
							createObjectStore: () => ({}),
						}
					: undefined;
				if (!database) {
					database = new Map();
					databases.set(name, database);
				}
				// The request's result exists before the upgrade event fires, as in real IDB.
				(request as unknown as { result: unknown }).result = {
					objectStoreNames: { contains: () => true },
					close: () => undefined,
					onversionchange: null,
					transaction(_store: string, mode: IDBTransactionMode) {
						if (options.failTransactions) throw new Error("transaction refused");
						const entries = database as Map<string, unknown>;
						const transaction = {
							mode,
							oncomplete: null as unknown,
							onerror: null as unknown,
							onabort: null as unknown,
							abort: () => undefined,
							objectStore() {
								return {
									get(key: string) {
										const request = eventual({
											onsuccess: null,
											onerror: null,
											result: undefined as unknown,
										});
										setTimeout(() => {
											if (options.failTransactions) {
												request.onerror?.({
													target: { error: new Error("failed") },
												} as unknown as Event);
												return;
											}
											(request as unknown as { result: unknown }).result = entries.get(key);
											request.onsuccess?.(null as unknown as Event);
											transaction.oncomplete?.(null as unknown as Event);
										}, options.delayMs ?? 0);
										return request;
									},
									put(value: unknown, key: string) {
										const request = eventual({
											onsuccess: null,
											onerror: null,
											result: undefined as unknown,
										});
										setTimeout(() => {
											if (options.quota) {
												transaction.onerror?.({
													target: { error: new Error("QuotaExceededError") },
												} as unknown as Event);
												return;
											}
											entries.set(key, value);
											request.onsuccess?.(null as unknown as Event);
											transaction.oncomplete?.(null as unknown as Event);
										}, options.delayMs ?? 0);
										return request;
									},
									delete(key: string) {
										const request = eventual({
											onsuccess: null,
											onerror: null,
											result: undefined as unknown,
										});
										setTimeout(() => {
											entries.delete(key);
											request.onsuccess?.(null as unknown as Event);
											transaction.oncomplete?.(null as unknown as Event);
										}, options.delayMs ?? 0);
										return request;
									},
									openCursor() {
										const request = eventual({
											onsuccess: null,
											onerror: null,
											result: null as unknown,
										});
										setTimeout(() => {
											let index = 0;
											const visit = () => {
												const keys = [...entries.keys()];
												if (index >= keys.length) {
													(request as unknown as { result: unknown }).result = null;
													request.onsuccess?.(null as unknown as Event);
													transaction.oncomplete?.(null as unknown as Event);
													return;
												}
												const key = keys[index] as string;
												index += 1;
												(request as unknown as { result: unknown }).result = {
													key,
													delete: () => entries.delete(key),
													continue: visit,
												};
												request.onsuccess?.(null as unknown as Event);
											};
											visit();
										}, options.delayMs ?? 0);
										return request;
									},
								};
							},
						} as unknown as IDBTransaction;
						return transaction;
					},
				};
				if (upgrade) request.onupgradeneeded?.({ target: { result: upgrade } } as unknown as Event);
				request.onsuccess?.(null as unknown as Event);
			}, 0);
			return request as unknown as IDBOpenDBRequest;
		},
	} as unknown as IDBFactory;
	return instance;
}

type Requestish = {
	onsuccess?: ((event: Event) => void) | null;
	onerror?: ((event: Event) => void) | null;
	onupgradeneeded?: ((event: Event) => void) | null;
	onblocked?: ((event: Event) => void) | null;
	result?: unknown;
	readyState?: string;
};

function eventual(shape: Requestish): Requestish {
	return { ...shape };
}

describe("browser cache contract", () => {
	it("recovers from a transient open failure and bounds repeated unavailable opens", async () => {
		const options = { unavailable: true };
		const factory = fakeFactory(options),
			opens = vi.spyOn(factory, "open");
		const cache = createBrowserCache(factory);
		expect(await cache.get("value")).toBeUndefined();
		options.unavailable = false;
		expect(await cache.put("value", 42)).toBe(true);
		expect(await cache.get("value")).toBe(42);
		expect(opens).toHaveBeenCalledTimes(2);
		const unavailable = fakeFactory({ unavailable: true }),
			failures = vi.spyOn(unavailable, "open");
		const failed = createBrowserCache(unavailable);
		await failed.get("a");
		await failed.get("b");
		await failed.get("c");
		expect(failures).toHaveBeenCalledTimes(2);
	});
	it("exposes the shared cache and the owned database identity", () => {
		expect(typeof browserCache.get).toBe("function");
		expect(typeof browserCache.put).toBe("function");
		expect(typeof browserCache.remove).toBe("function");
		expect(typeof browserCache.retain).toBe("function");
		expect(BROWSER_CACHE_DATABASE).toBe("flow-atlas-publication-cache-v1");
		expect(BROWSER_CACHE_STORE).toBe("entries");
		expect(BROWSER_CACHE_SCHEMA_VERSION).toBe(1);
	});

	it("stores and returns binary and structured values without JSON conversion", async () => {
		const cache = createBrowserCache(fakeFactory());
		const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
		expect(await cache.put("raw:alpha", bytes)).toBe(true);
		expect(await cache.put("map:current", { samples: 33, offsets: new Int32Array([7, 9]) })).toBe(
			true,
		);
		expect(await cache.get("missing")).toBeUndefined();
		const loaded = await cache.get("raw:alpha");
		expect(loaded).toBeInstanceOf(ArrayBuffer);
		expect(new Uint8Array(loaded as ArrayBuffer)[2]).toBe(3);
		const map = (await cache.get("map:current")) as { samples: number; offsets: Int32Array };
		expect(map.samples).toBe(33);
		expect(map.offsets[1]).toBe(9);
	});

	it("removes entries and retains exactly the requested key set", async () => {
		const cache = createBrowserCache(fakeFactory());
		await cache.put("a", 1);
		await cache.put("b", 2);
		await cache.put("map:current", 3);
		await cache.remove("a");
		expect(await cache.get("a")).toBeUndefined();
		expect(await cache.get("b")).toBe(2);
		await cache.retain(new Set(["map:current"]));
		expect(await cache.get("b")).toBeUndefined();
		expect(await cache.get("map:current")).toBe(3);
		// Retaining an empty set empties the store but keeps the database usable.
		await cache.retain(new Set());
		expect(await cache.get("map:current")).toBeUndefined();
		expect(await cache.put("after", 4)).toBe(true);
	});

	it("returns misses and false when IndexedDB is unavailable", async () => {
		const cache = createBrowserCache(fakeFactory({ unavailable: true }));
		expect(await cache.get("raw:x")).toBeUndefined();
		expect(await cache.put("raw:x", new ArrayBuffer(8))).toBe(false);
		await cache.remove("raw:x");
		await cache.retain(new Set(["map:current"]));
		expect(await cache.get("raw:x")).toBeUndefined();
	});

	it("degrades transactions failures to misses without throwing", async () => {
		const cache = createBrowserCache(fakeFactory({ failTransactions: true }));
		expect(await cache.get("k")).toBeUndefined();
		expect(await cache.put("k", 1)).toBe(false);
		await cache.remove("k");
		await cache.retain(new Set());
	});

	it("reports quota failures as a false put and keeps the cache usable for reads", async () => {
		const cache = createBrowserCache(fakeFactory({ quota: true }));
		expect(await cache.put("huge", new ArrayBuffer(16))).toBe(false);
		expect(await cache.get("huge")).toBeUndefined();
	});

	it("resolves within the bounded wait when the open hangs", async () => {
		const cache = createBrowserCache(fakeFactory({ unavailable: true, delayMs: 60_000 }));
		const started = Date.now();
		expect(await cache.get("k")).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(10_000);
	});
});
