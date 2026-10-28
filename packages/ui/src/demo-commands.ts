type CommandEvent = { type: "tool-call" | "tool-result" | "error"; text: string };
type Invoke = (
	name: string,
	input: unknown,
	signal: AbortSignal,
	guard: () => Promise<void>,
) => Promise<unknown>;
type Epoch = {
	token: string;
	controller: AbortController;
	timer?: ReturnType<typeof setTimeout>;
	warned?: boolean;
};
type Command = { id: string; name: string; arguments: unknown; remainingMs: number };
const aborted = () => new DOMException("Command no longer pending", "AbortError");
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const remaining = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;
const identifier = (value: unknown): value is string =>
	typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);

/** Session-local MCP delivery. Tokens are captured once, never persisted or emitted. */
export class DemoCommands {
	private epoch: Epoch | undefined;
	constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

	start(connection: { token: string }, invoke: Invoke, onEvent: (event: CommandEvent) => void) {
		this.stop();
		const epoch: Epoch = { token: connection.token, controller: new AbortController() };
		this.epoch = epoch;
		void this.poll(epoch, invoke, onEvent);
	}

	stop() {
		const epoch = this.epoch;
		if (!epoch) return;
		this.epoch = undefined;
		clearTimeout(epoch.timer);
		epoch.controller.abort();
		// Cancellation must survive the polling abort, but never retain a live timer indefinitely.
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5_000);
		try {
			void this.fetcher("/api/demo/cancel", {
				method: "POST",
				headers: this.headers(epoch),
				signal: controller.signal,
			})
				.catch(() => {})
				.finally(() => clearTimeout(timer));
		} catch {
			clearTimeout(timer);
		}
	}

	private active(epoch: Epoch) {
		return this.epoch === epoch && !epoch.controller.signal.aborted;
	}
	private headers(epoch: Epoch) {
		return { Authorization: `Bearer ${epoch.token}`, "Content-Type": "application/json" };
	}
	private authorized(epoch: Epoch, response: Response) {
		if (response.status === 401 || response.status === 403) {
			if (this.active(epoch)) this.stop();
			throw new Error("MCP connection expired");
		}
	}

	private async poll(epoch: Epoch, invoke: Invoke, onEvent: (event: CommandEvent) => void) {
		if (!this.active(epoch)) return;
		try {
			const response = await this.fetcher("/api/demo/commands", {
				headers: this.headers(epoch),
				signal: epoch.controller.signal,
			});
			if (!this.active(epoch)) return;
			this.authorized(epoch, response);
			if (!response.ok) throw new Error("Poll failed");
			const receivedAt = Date.now();
			const payload: unknown = await response.json();
			if (!this.active(epoch)) return;
			if (!record(payload) || !Array.isArray(payload.commands) || payload.commands.length > 8)
				throw new Error("Invalid command batch");
			const ids = new Set<string>();
			const commands: Command[] = payload.commands.map((item: unknown) => {
				if (
					!record(item) ||
					!identifier(item.id) ||
					!identifier(item.name) ||
					!remaining(item.remainingMs) ||
					ids.has(item.id)
				)
					throw new Error("Invalid command");
				ids.add(item.id);
				return {
					id: item.id,
					name: item.name,
					arguments: item.arguments,
					remainingMs: item.remainingMs,
				};
			});
			epoch.warned = false;
			for (const command of commands) {
				if (!this.active(epoch)) return;
				await this.run(epoch, command, receivedAt, invoke, onEvent);
			}
		} catch {
			if (this.active(epoch) && !epoch.warned) {
				epoch.warned = true;
				onEvent({ type: "error", text: "MCP command delivery failed" });
			}
		} finally {
			if (this.active(epoch))
				epoch.timer = setTimeout(() => {
					void this.poll(epoch, invoke, onEvent);
				}, 750);
		}
	}

	private async run(
		epoch: Epoch,
		command: Command,
		receivedAt: number,
		invoke: Invoke,
		onEvent: (event: CommandEvent) => void,
	) {
		const controller = new AbortController();
		const signal = controller.signal;
		let deadline = receivedAt + Math.min(45_000, command.remainingMs);
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		let monitorTimer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			controller.abort();
			clearTimeout(deadlineTimer);
			clearTimeout(monitorTimer);
		};
		const assertActive = () => {
			if (!this.active(epoch) || signal.aborted || Date.now() >= deadline) {
				abort();
				throw aborted();
			}
		};
		const armDeadline = () => {
			clearTimeout(deadlineTimer);
			deadlineTimer = setTimeout(abort, Math.max(0, deadline - Date.now()));
		};
		epoch.controller.signal.addEventListener("abort", abort, { once: true });
		armDeadline();
		let checking: Promise<void> | undefined;
		const guard = async () => {
			assertActive();
			if (!checking)
				checking = (async () => {
					try {
						const response = await this.fetcher(
							`/api/demo/commands/${encodeURIComponent(command.id)}`,
							{
								headers: this.headers(epoch),
								signal,
							},
						);
						assertActive();
						this.authorized(epoch, response);
						if (!response.ok) throw aborted();
						const checkedAt = Date.now();
						const payload: unknown = await response.json();
						assertActive();
						if (!record(payload) || payload.pending !== true || !remaining(payload.remainingMs))
							throw aborted();
						deadline = Math.min(deadline, checkedAt + payload.remainingMs);
						assertActive();
						armDeadline();
					} catch (error) {
						abort();
						throw error;
					}
				})();
			const request = checking;
			try {
				await request;
				assertActive();
			} finally {
				if (checking === request) checking = undefined;
			}
		};
		const monitor = async () => {
			try {
				await guard();
				assertActive();
				monitorTimer = setTimeout(() => void monitor(), 750);
			} catch {
				// The failed guard has aborted the command; run owns its terminal event.
			}
		};
		let rejectAbort: (() => void) | undefined;
		try {
			await guard();
			onEvent({ type: "tool-call", text: `MCP · ${command.name}` });
			monitorTimer = setTimeout(() => void monitor(), 750);
			const cancelled = new Promise<never>((_, reject) => {
				rejectAbort = () => reject(aborted());
				signal.addEventListener("abort", rejectAbort, { once: true });
			});
			let result: unknown;
			let isError = false;
			try {
				assertActive();
				result = await Promise.race([
					Promise.resolve().then(() => {
						assertActive();
						return invoke(command.name, command.arguments, signal, guard);
					}),
					cancelled,
				]);
			} catch {
				assertActive();
				result = { error: "MCP tool invocation failed" };
				isError = true;
			}
			await guard();
			const response = await this.fetcher("/api/demo/results", {
				method: "POST",
				headers: this.headers(epoch),
				body: JSON.stringify({ id: command.id, result, isError }),
				signal,
			});
			assertActive();
			this.authorized(epoch, response);
			if (!response.ok) throw new Error("Result rejected");
			onEvent({
				type: "tool-result",
				text: `${command.name}: ${isError ? "failed" : "completed"}`,
			});
		} catch {
			if (this.active(epoch)) onEvent({ type: "error", text: `${command.name}: not completed` });
		} finally {
			if (rejectAbort) signal.removeEventListener("abort", rejectAbort);
			abort();
			epoch.controller.signal.removeEventListener("abort", abort);
		}
	}
}
