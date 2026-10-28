/** Browser-only transport. Session credentials and completed turns stay in memory. */
export type AgentEvent = {
	type: "status" | "text" | "tool-call" | "tool-result" | "error";
	text: string;
	name?: string;
	id?: string;
};

type Invoke = (name: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
type Connection = { token: string; expiresAt: string | number };
type TextBlock = { type: "text"; text: string };
type ToolBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type ResultBlock = {
	type: "tool_result";
	tool_use_id: string;
	content: string;
	is_error?: boolean;
};
type Message = { role: "user" | "assistant"; content: (TextBlock | ToolBlock | ResultBlock)[] };

const TOOLS = new Set([
	"inspect_dataset",
	"list_populations",
	"inspect_population",
	"create_population",
	"rename_population",
	"delete_population",
	"select_population",
	"set_marker",
]);
const HISTORY_BYTES = 120 * 1024;
const RESULT_BYTES = 24 * 1024;
export const AGENT_EVENT_TEXT_LIMIT = 4000;
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).byteLength;
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

class AgentFailure extends Error {}
function fail(message: string): never {
	throw new AgentFailure(message);
}

export class DemoAgent {
	private readonly fetcher: typeof fetch;
	private session: Connection | null = null;
	private history: Message[][] = [];
	private epoch = 0;
	private active: AbortController | null = null;
	private sessionRequest: AbortController | null = null;

	constructor(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
		this.fetcher = fetcher;
	}

	get connected(): boolean {
		return this.session !== null;
	}

	/** Explicit connection-info action only; never persist or place this in a URL. */
	connection(): Connection | null {
		return this.session ? { ...this.session } : null;
	}

	async config(): Promise<{ agentConfigured: boolean; speechConfigured: boolean; model: string }> {
		try {
			const response = await this.fetcher("/api/demo/config");
			if (!response.ok) fail("Demo configuration unavailable.");
			const value: unknown = await response.json();
			if (
				!record(value) ||
				typeof value.agentConfigured !== "boolean" ||
				typeof value.speechConfigured !== "boolean" ||
				typeof value.model !== "string"
			)
				fail("Invalid demo configuration.");
			return {
				agentConfigured: value.agentConfigured,
				speechConfigured: value.speechConfigured,
				model: value.model,
			};
		} catch {
			throw new Error("Demo configuration unavailable.");
		}
	}

	async connect(accessCode: string): Promise<void> {
		if (!accessCode.trim()) fail("Enter an access code.");
		this.reset();
		this.session = null;
		const epoch = this.epoch;
		const controller = new AbortController();
		this.sessionRequest = controller;
		try {
			await this.sessionDeadline(controller, async () => {
				const response = await this.fetcher("/api/demo/session", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ accessCode }),
					signal: controller.signal,
				});
				this.check(epoch, controller);
				if (!response.ok) fail("Demo connection failed.");
				const value: unknown = await response.json();
				this.check(epoch, controller);
				if (
					!record(value) ||
					typeof value.token !== "string" ||
					!value.token ||
					!(
						(typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)) ||
						(typeof value.expiresAt === "string" && value.expiresAt.length > 0)
					)
				)
					fail("Invalid demo session.");
				this.session = { token: value.token, expiresAt: value.expiresAt };
			});
		} catch {
			throw new Error("Demo connection failed or cancelled.");
		} finally {
			if (this.sessionRequest === controller) this.sessionRequest = null;
		}
	}

	cancel(): void {
		this.epoch++;
		this.active?.abort();
		this.sessionRequest?.abort();
	}

	/** Reset conversation without revoking the current session. */
	reset(): void {
		this.cancel();
		this.history = [];
	}

	async disconnect(): Promise<void> {
		const session = this.session;
		this.reset();
		this.session = null;
		if (!session) return;
		const controller = new AbortController();
		this.sessionRequest = controller;
		const epoch = this.epoch;
		try {
			await this.sessionDeadline(controller, async () => {
				const response = await this.fetcher("/api/demo/session", {
					method: "DELETE",
					keepalive: true,
					headers: { Authorization: `Bearer ${session.token}` },
					signal: controller.signal,
				});
				this.check(epoch, controller);
				if (!response.ok) fail("Session revocation failed; local connection cleared.");
			});
		} catch {
			throw new Error("Session revocation failed or cancelled; local connection cleared.");
		} finally {
			if (this.sessionRequest === controller) this.sessionRequest = null;
		}
	}
	private async sessionDeadline<T>(
		controller: AbortController,
		action: () => Promise<T>,
	): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				action(),
				new Promise<T>((_, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						reject(new Error("Session request timed out"));
					}, 10_000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	private check(epoch: number, controller: AbortController): void {
		if (epoch !== this.epoch || controller.signal.aborted) {
			throw new DOMException("Cancelled", "AbortError");
		}
	}

	async ask(
		text: string,
		context: unknown,
		invoke: Invoke,
		onEvent: (event: AgentEvent) => void,
	): Promise<void> {
		if (this.active) fail("Agent is busy.");
		if (!text.trim() || text.length > 4000) fail("Request must contain 1–4000 characters.");
		const session = this.session;
		if (!session) fail("Connect before asking the agent.");
		const controller = new AbortController();
		this.active = controller;
		const epoch = this.epoch;
		const emit = (event: AgentEvent) => {
			this.check(epoch, controller);
			try {
				onEvent({ ...event, text: event.text.slice(0, AGENT_EVENT_TEXT_LIMIT) });
			} catch {
				// Observers must not interrupt the protocol or cause tool re-execution.
			}
			this.check(epoch, controller);
		};
		try {
			const turn: Message[] = [
				{
					role: "user",
					content: [{ type: "text", text: JSON.stringify({ context, request: text }) }],
				},
			];
			const prior = [...this.history];
			const fit = () => {
				if (bytes(JSON.stringify(turn)) > HISTORY_BYTES)
					fail("Conversation turn exceeds the size limit.");
				while (
					bytes(JSON.stringify([...prior.flat(), ...turn])) > HISTORY_BYTES ||
					prior.flat().length + turn.length > 32
				)
					prior.shift();
				return [...prior.flat(), ...turn];
			};
			let calls = 0;
			const ids = new Set(
				prior
					.flat()
					.flatMap((message) =>
						message.content.flatMap((block) => (block.type === "tool_use" ? [block.id] : [])),
					),
			);
			for (let round = 0; round < 8; round++) {
				const messages = fit();
				emit({ type: "status", text: `Contacting agent (${round + 1}/8).` });
				const response = await this.fetcher("/api/demo/agent", {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
					body: JSON.stringify({ messages }),
					signal: controller.signal,
				});
				this.check(epoch, controller);
				if (!response.ok) fail("Agent request failed.");
				const value: unknown = await response.json();
				this.check(epoch, controller);
				const content = this.validate(value, ids);
				const tools = content.filter((block): block is ToolBlock => block.type === "tool_use");
				if (calls + tools.length > 24 || (round === 7 && tools.length))
					fail("Agent tool budget exceeded.");
				turn.push({ role: "assistant", content });
				fit(); // Reject oversized/malformed responses before any side effects.
				for (const block of content) {
					if (block.type === "text") emit({ type: "text", text: block.text });
				}
				if (!tools.length) {
					this.check(epoch, controller);
					this.history = [...prior, turn];
					emit({ type: "status", text: "Done." });
					return;
				}
				const results: ResultBlock[] = [];
				turn.push({ role: "user", content: results });
				for (const tool of tools) {
					this.check(epoch, controller);
					calls++;
					emit({ type: "tool-call", name: tool.name, id: tool.id, text: `Calling ${tool.name}.` });
					let result: ResultBlock;
					try {
						const output = await invoke(tool.name, tool.input, controller.signal);
						this.check(epoch, controller);
						const serialized = JSON.stringify(output);
						if (serialized === undefined || bytes(serialized) > RESULT_BYTES)
							fail("Tool result exceeds the size limit or is not JSON.");
						result = { type: "tool_result", tool_use_id: tool.id, content: serialized };
					} catch {
						this.check(epoch, controller);
						const message = "Tool failed or returned an invalid/oversized result.";
						result = {
							type: "tool_result",
							tool_use_id: tool.id,
							content: JSON.stringify({ error: message }),
							is_error: true,
						};
						emit({ type: "error", name: tool.name, id: tool.id, text: message });
					}
					results.push(result);
					fit();
					emit({ type: "tool-result", name: tool.name, id: tool.id, text: result.content });
				}
			}
		} catch (error) {
			if (epoch !== this.epoch || controller.signal.aborted) return;
			const message = error instanceof AgentFailure ? error.message : "Agent request failed.";
			emit({ type: "error", text: message });
			throw new Error(message);
		} finally {
			if (this.active === controller) this.active = null;
		}
	}

	private validate(value: unknown, ids: Set<string>): (TextBlock | ToolBlock)[] {
		if (
			!record(value) ||
			!Array.isArray(value.content) ||
			!value.content.length ||
			value.content.length > 64 ||
			(value.stop_reason !== "tool_use" && value.stop_reason !== "end_turn")
		)
			fail("Incomplete or invalid agent response.");
		const content: (TextBlock | ToolBlock)[] = [];
		for (const block of value.content) {
			if (!record(block)) fail("Invalid agent content.");
			if (block.type === "text" && typeof block.text === "string") {
				content.push({ type: "text", text: block.text });
			} else if (
				block.type === "tool_use" &&
				typeof block.id === "string" &&
				block.id.length > 0 &&
				/^[A-Za-z0-9_-]{1,128}$/.test(block.id) &&
				typeof block.name === "string" &&
				TOOLS.has(block.name) &&
				"input" in block &&
				!ids.has(block.id)
			) {
				ids.add(block.id);
				content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
			} else fail("Invalid or unsupported agent content.");
		}
		const hasTools = content.some((block) => block.type === "tool_use");
		if (hasTools !== (value.stop_reason === "tool_use"))
			fail("Incomplete or invalid tool response.");
		return content;
	}
}
