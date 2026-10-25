/**
 * Best-effort persistent browser cache over native IndexedDB.
 *
 * Owns exactly one database ('flow-atlas-publication-cache-v1') with one object
 * store ('entries', schema 1). Values are stored with structured clone, so
 * ArrayBuffers and Blobs are kept as binary data, never JSON/base64. Every
 * failure — unavailability (Node), quota, blocking, security errors, timeouts —
 * degrades to a miss or a false return and never fails the application. Every
 * wait is time-bounded; no callback can hang past the bound.
 */

const DATABASE = "flow-atlas-publication-cache-v1";
const STORE = "entries";
const SCHEMA_VERSION = 1;
/** Normal operations must resolve within this bound. */
const OPEN_TIMEOUT_MS = 5_000;
/** Large puts (a ~400 MB derived map) may legitimately take longer. */
const PUT_TIMEOUT_MS = 10_000;

export interface BrowserCache {
	get(key: string): Promise<unknown | undefined>;
	put(key: string, value: unknown): Promise<boolean>;
	remove(key: string): Promise<void>;
	/** Keep exactly `keys`; every other entry in this store is evicted. */
	retain(keys: ReadonlySet<string>): Promise<void>;
}

/** Narrow an unknown error to a message for diagnostics; never throws. */
function describe(error: unknown): string {
	if (error instanceof Error) return error.message;
	return typeof error === "string" ? error : "unknown cache error";
}

function factory(factoryOverride: IDBFactory | undefined): IDBFactory | undefined {
	const candidate = factoryOverride ?? globalThis.indexedDB;
	if (typeof candidate?.open !== "function") return undefined;
	return candidate;
}

/** Open the owned database, or undefined when unavailable/failed/timed out. */
async function openDatabase(
	source: IDBFactory,
	timeoutMs: number,
): Promise<IDBDatabase | undefined> {
	return new Promise<IDBDatabase | undefined>((resolvePromise) => {
		let settled = false;
		const settle = (value: IDBDatabase | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise(value);
		};
		const timer = setTimeout(() => settle(undefined), timeoutMs);
		let request: IDBOpenDBRequest;
		try {
			request = source.open(DATABASE, SCHEMA_VERSION);
		} catch {
			settle(undefined);
			return;
		}
		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(STORE)) {
				try {
					database.createObjectStore(STORE);
				} catch {
					// The store may already exist from a concurrent opener.
				}
			}
		};
		request.onsuccess = () => {
			const database = request.result;
			if (settled) {
				database.close();
				return;
			}
			// A competing version upgrade takes priority; yield our connection.
			database.onversionchange = () => {
				try {
					database.close();
				} catch {
					// Already closed elsewhere.
				}
			};
			settle(database);
		};
		request.onerror = () => settle(undefined);
		request.onblocked = () => {
			// Another connection holds the old version open; the bounded timer decides.
		};
	});
}

/**
 * Run one bounded transaction and resolve only on `oncomplete` (durable), never
 * merely on request success. Any failure resolves the fallback value.
 */
async function withTransaction<T>(
	database: IDBDatabase,
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore) => void,
	timeoutMs: number,
	fallback: T,
): Promise<T> {
	return new Promise<T>((resolvePromise) => {
		let settled = false;
		const settle = (value: T) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise(value);
		};
		const timer = setTimeout(() => {
			try {
				transaction.abort();
			} catch {
				// Already finished.
			}
			settle(fallback);
		}, timeoutMs);
		let transaction: IDBTransaction;
		try {
			transaction = database.transaction(STORE, mode);
		} catch {
			settle(fallback);
			return;
		}
		transaction.oncomplete = () => settle(fallback === undefined ? fallback : (result ?? fallback));
		transaction.onerror = () => settle(fallback);
		transaction.onabort = () => settle(fallback);
		let result: T | undefined;
		try {
			operation(transaction.objectStore(STORE));
		} catch (error) {
			void describe(error);
			try {
				transaction.abort();
			} catch {
				// Already finished.
			}
			settle(fallback);
			return;
		}
		void result;
	});
}

function createCache(factoryOverride?: IDBFactory): BrowserCache {
	// The database handle is cached per cache instance; a version change or failed
	// operation drops it so the next call reopens.
	let cached: IDBDatabase | undefined;
	let opening: Promise<IDBDatabase | undefined> | undefined;
	let failedOpenAttempts = 0;

	const usable = async (): Promise<IDBDatabase | undefined> => {
		if (cached) return cached;
		if (opening) return opening;
		// One retry handles a transient open failure without multiplying a blocked
		// five-second wait by every file in the dataset. Reload resets this budget.
		if (failedOpenAttempts >= 2) return undefined;
		const source = factory(factoryOverride);
		if (!source) return undefined;
		const attempt: Promise<IDBDatabase | undefined> = openDatabase(source, OPEN_TIMEOUT_MS).then(
			(database) => {
				if (!database) {
					failedOpenAttempts++;
					if (opening === attempt) opening = undefined;
					return undefined;
				}
				failedOpenAttempts = 0;
				cached = database;
				database.onversionchange = () => {
					database.close();
					cached = undefined;
					opening = undefined;
				};
				return database;
			},
		);
		opening = attempt;
		return attempt;
	};

	const drop = () => {
		try {
			cached?.close();
		} catch {
			// Already closed.
		}
		cached = undefined;
		opening = undefined;
	};

	const _run = async <T>(
		mode: IDBTransactionMode,
		operation: (store: IDBObjectStore, done: (value: T) => void) => void,
		timeoutMs: number,
		fallback: T,
	): Promise<T> => {
		const database = await usable();
		if (!database) return fallback;
		try {
			return await withTransaction<T>(
				database,
				mode,
				(store) => operation(store, () => undefined),
				timeoutMs,
				fallback,
			);
		} catch {
			drop();
			return fallback;
		}
	};

	return {
		async get(key) {
			const database = await usable();
			if (!database) return undefined;
			return new Promise<unknown | undefined>((resolvePromise) => {
				let settled = false;
				const settle = (value: unknown | undefined) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolvePromise(value);
				};
				const timer = setTimeout(() => settle(undefined), OPEN_TIMEOUT_MS);
				let transaction: IDBTransaction;
				try {
					transaction = database.transaction(STORE, "readonly");
				} catch {
					settle(undefined);
					drop();
					return;
				}
				transaction.oncomplete = () => settle(resolved);
				transaction.onerror = () => settle(undefined);
				transaction.onabort = () => settle(undefined);
				let resolved: unknown | undefined;
				try {
					const request = transaction.objectStore(STORE).get(key);
					request.onsuccess = () => {
						resolved = request.result === undefined ? undefined : request.result;
					};
					request.onerror = () => {
						resolved = undefined;
					};
				} catch {
					settle(undefined);
				}
			}).catch(() => {
				drop();
				return undefined;
			});
		},
		async put(key, value) {
			const database = await usable();
			if (!database) return false;
			return new Promise<boolean>((resolvePromise) => {
				let settled = false;
				const settle = (result: boolean) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolvePromise(result);
				};
				const timer = setTimeout(() => {
					try {
						transaction.abort();
					} catch {
						// Already finished.
					}
					settle(false);
				}, PUT_TIMEOUT_MS);
				let transaction: IDBTransaction;
				try {
					transaction = database.transaction(STORE, "readwrite");
				} catch {
					settle(false);
					drop();
					return;
				}
				// Durable success requires the transaction itself to complete.
				transaction.oncomplete = () => settle(true);
				transaction.onerror = () => settle(false);
				transaction.onabort = () => settle(false);
				try {
					transaction.objectStore(STORE).put(value, key);
				} catch (error) {
					// QuotaExceededError and friends; report a plain false.
					void describe(error);
					try {
						transaction.abort();
					} catch {
						// Already finished.
					}
					settle(false);
				}
			}).catch(() => {
				drop();
				return false;
			});
		},
		async remove(key) {
			const database = await usable();
			if (!database) return;
			await new Promise<void>((resolvePromise) => {
				let settled = false;
				const settle = () => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolvePromise();
				};
				const timer = setTimeout(settle, OPEN_TIMEOUT_MS);
				let transaction: IDBTransaction;
				try {
					transaction = database.transaction(STORE, "readwrite");
				} catch {
					settle();
					return;
				}
				transaction.oncomplete = settle;
				transaction.onerror = settle;
				transaction.onabort = settle;
				try {
					transaction.objectStore(STORE).delete(key);
				} catch {
					try {
						transaction.abort();
					} catch {
						// Already finished.
					}
					settle();
				}
			}).catch(() => undefined);
		},
		async retain(keys) {
			const database = await usable();
			if (!database) return;
			await new Promise<void>((resolvePromise) => {
				let settled = false;
				const settle = () => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolvePromise();
				};
				const timer = setTimeout(settle, PUT_TIMEOUT_MS);
				let transaction: IDBTransaction;
				try {
					transaction = database.transaction(STORE, "readwrite");
				} catch {
					settle();
					return;
				}
				transaction.oncomplete = settle;
				transaction.onerror = settle;
				transaction.onabort = settle;
				try {
					// A key cursor removes only this store's own entries; other stores and
					// databases are never touched. Keys like 'map:current' are retained by
					// the caller's set.
					const cursorRequest = transaction.objectStore(STORE).openCursor();
					cursorRequest.onsuccess = () => {
						const cursor = cursorRequest.result;
						if (!cursor) return;
						if (!keys.has(String(cursor.key))) cursor.delete();
						cursor.continue();
					};
				} catch {
					try {
						transaction.abort();
					} catch {
						// Already finished.
					}
					settle();
				}
			}).catch(() => undefined);
		},
	};
}

/** Shared best-effort cache bound to the publication database. */
export const browserCache: BrowserCache = createCache();

/** Test seam: build an isolated cache against an injected IDBFactory. */
export function createBrowserCache(injected?: IDBFactory): BrowserCache {
	return createCache(injected);
}

export {
	DATABASE as BROWSER_CACHE_DATABASE,
	SCHEMA_VERSION as BROWSER_CACHE_SCHEMA_VERSION,
	STORE as BROWSER_CACHE_STORE,
};
