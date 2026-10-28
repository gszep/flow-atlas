export type DictationState = "idle" | "connecting" | "recording" | "finishing" | "error";

interface Options {
	getToken: () => string | null;
	onText: (finalText: string, interimText: string) => void;
	onState: (state: DictationState, message?: string) => void;
}

interface Session {
	abort: AbortController;
	stream?: MediaStream;
	context?: AudioContext;
	source?: MediaStreamAudioSourceNode;
	node?: AudioWorkletNode;
	gain?: GainNode;
	socket?: WebSocket;
	ready: boolean;
	state: DictationState;
	timers: Set<ReturnType<typeof setTimeout>>;
	wake: Set<() => void>;
	flush?: () => void;
	finish?: () => void;
	stop?: Promise<void>;
	finals: string[];
	seen: Set<string>;
}

/** Audio is sent only to the authenticated speech relay; never submits an agent prompt. */
export class Dictation {
	private current: Session | undefined;
	constructor(private readonly options: Options) {}

	get recording(): boolean {
		return this.current?.state === "recording";
	}

	private active(s: Session): boolean {
		return this.current === s;
	}

	private state(s: Session, state: DictationState, message?: string): void {
		if (!this.active(s)) return;
		s.state = state;
		this.options.onState(state, message);
	}

	private timer(s: Session, callback: () => void, ms: number): void {
		const id = setTimeout(() => {
			s.timers.delete(id);
			if (this.active(s)) callback();
		}, ms);
		s.timers.add(id);
	}

	private cleanup(s: Session): void {
		if (this.active(s)) this.current = undefined;
		s.abort.abort();
		for (const timer of s.timers) clearTimeout(timer);
		for (const wake of s.wake) wake();
		s.timers.clear();
		s.wake.clear();
		if (s.node) {
			s.node.port.onmessage = null;
			s.node.onprocessorerror = null;
			s.node.port.close();
			s.node.disconnect();
		}
		s.source?.disconnect();
		s.gain?.disconnect();
		for (const track of s.stream?.getTracks() ?? []) track.stop();
		if (s.context && s.context.state !== "closed") void s.context.close().catch(() => {});
		if (s.socket) {
			s.socket.onmessage = null;
			s.socket.onerror = null;
			s.socket.onclose = null;
			s.socket.close();
		}
	}

	private fail(s: Session, message: string): void {
		if (!this.active(s)) return;
		this.cleanup(s);
		this.options.onState("error", message);
	}

	private send(s: Session, data: string | ArrayBuffer): boolean {
		if (!this.active(s)) return false;
		const size = typeof data === "string" ? data.length : data.byteLength;
		if (!s.ready || s.socket?.readyState !== WebSocket.OPEN) {
			this.fail(s, "Speech connection is not ready.");
			return false;
		}
		if (s.socket.bufferedAmount + size > 128 * 1024) {
			this.fail(s, "Speech connection is too slow. Please try again.");
			return false;
		}
		try {
			s.socket.send(data);
			return true;
		} catch {
			this.fail(s, "Speech connection failed.");
			return false;
		}
	}

	private message(s: Session, data: unknown): void {
		if (!this.active(s) || typeof data !== "string" || data.length > 128 * 1024) return;
		let message: {
			type?: string;
			is_final?: boolean;
			start?: number;
			duration?: number;
			channel?: { alternatives?: { transcript?: string }[] };
		};
		try {
			message = JSON.parse(data);
		} catch {
			return;
		}
		if (!message || typeof message !== "object") return;
		if (message.type === "Metadata") {
			s.finish?.();
			return;
		}
		if (message.type === "Error") {
			this.fail(s, "Speech service failed. Please try again.");
			return;
		}
		if (message.type !== "Results") return;
		const text = message.channel?.alternatives?.[0]?.transcript;
		if (typeof text !== "string") return;
		if (message.is_final === true) {
			// Deepgram timing identifies a segment, including retransmitted final results.
			const key =
				Number.isFinite(message.start) && Number.isFinite(message.duration)
					? `${message.start}:${message.duration}`
					: `text:${text}`;
			if (!s.seen.has(key)) {
				s.seen.add(key);
				if (text.trim()) s.finals.push(text.trim());
			}
			this.options.onText(s.finals.join(" "), "");
		} else {
			this.options.onText(s.finals.join(" "), text);
		}
	}

	async start(): Promise<void> {
		this.cancel();
		const token = this.options.getToken();
		if (!token) {
			this.options.onState("error", "Sign in before starting dictation.");
			return;
		}
		const s: Session = {
			abort: new AbortController(),
			ready: false,
			state: "connecting",
			timers: new Set(),
			wake: new Set(),
			finals: [],
			seen: new Set(),
		};
		this.current = s;
		this.state(s, "connecting");
		if (!this.active(s)) return;
		this.timer(s, () => this.fail(s, "Dictation connection timed out."), 30_000);
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
			});
			if (!this.active(s)) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			s.stream = stream;
			const context = new AudioContext({ sampleRate: 16_000 });
			s.context = context;
			await context.resume();
			if (!this.active(s)) return;
			const response = await fetch("/api/demo/speech-ticket", {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: "{}",
				signal: s.abort.signal,
			});
			if (!this.active(s)) return;
			if (!response.ok) throw new Error("ticket");
			const ticket = await response.json();
			if (!this.active(s)) return;
			if (typeof ticket.ticket !== "string" || !ticket.ticket || !Number.isFinite(ticket.expiresAt))
				throw new Error("ticket");
			const url = new URL("/api/demo/speech", location.href);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			const socket = new WebSocket(url, ["flow-atlas.dictation", ticket.ticket]);
			s.socket = socket;
			await new Promise<void>((resolve) => {
				s.wake.add(resolve);
				socket.onmessage = (event) => {
					if (!this.active(s)) return;
					let ready = false;
					try {
						ready = JSON.parse(event.data).type === "Ready";
					} catch {
						/* Ignore malformed relay messages. */
					}
					if (ready && !s.ready) {
						s.ready = true;
						s.wake.delete(resolve);
						resolve();
					} else this.message(s, event.data);
				};
				socket.onerror = () => this.fail(s, "Speech connection failed.");
				socket.onclose = () => {
					if (s.finish) s.finish();
					else this.fail(s, "Speech connection closed unexpectedly.");
				};
			});
			if (!this.active(s)) return;
			await context.audioWorklet.addModule(new URL("./dictation-worklet.js", import.meta.url));
			if (!this.active(s)) return;
			const node = new AudioWorkletNode(context, "flow-atlas-dictation", { channelCount: 1 });
			s.node = node;
			node.onprocessorerror = () => this.fail(s, "Microphone processing failed.");
			node.port.onmessage = (event) => {
				if (!this.active(s)) return;
				if (event.data.type === "pcm" && event.data.buffer instanceof ArrayBuffer) {
					if (this.send(s, event.data.buffer)) node.port.postMessage({ type: "ack" });
				} else if (event.data.type === "flushed") s.flush?.();
				else if (event.data.type === "overflow") this.fail(s, "Microphone processing fell behind.");
			};
			s.source = context.createMediaStreamSource(stream);
			s.gain = context.createGain();
			s.gain.gain.value = 0;
			s.source.connect(node);
			node.connect(s.gain);
			s.gain.connect(context.destination);
			for (const timer of s.timers) clearTimeout(timer);
			s.timers.clear();
			this.state(s, "recording");
			if (!this.active(s)) return;
			this.timer(
				s,
				() => {
					void this.stop();
				},
				60_000,
			);
			const keepAlive = () => {
				if (this.send(s, JSON.stringify({ type: "KeepAlive" }))) this.timer(s, keepAlive, 4000);
			};
			this.timer(s, keepAlive, 4000);
		} catch {
			this.fail(
				s,
				"Could not start dictation. Check microphone permission and speech availability.",
			);
		}
	}

	async stop(): Promise<void> {
		const s = this.current;
		if (!s) return;
		if (s.stop) return s.stop;
		if (s.state !== "recording") {
			this.cancel();
			return;
		}
		this.state(s, "finishing");
		if (!this.active(s)) return;
		s.stop = this.finish(s);
		return s.stop;
	}

	private async finish(s: Session): Promise<void> {
		await new Promise<void>((resolve) => {
			s.wake.add(resolve);
			s.flush = () => {
				s.wake.delete(resolve);
				resolve();
			};
			this.timer(s, () => this.fail(s, "Microphone flush timed out."), 1000);
			s.node?.port.postMessage({ type: "flush" });
		});
		if (!this.active(s)) return;
		for (const timer of s.timers) clearTimeout(timer);
		s.timers.clear();
		await new Promise<void>((resolve) => {
			s.wake.add(resolve);
			s.finish = resolve;
			this.timer(s, resolve, 3000);
			// The port's FIFO flushed acknowledgement follows every final PCM message.
			if (this.send(s, JSON.stringify({ type: "Finalize" })))
				this.send(s, JSON.stringify({ type: "CloseStream" }));
		});
		if (!this.active(s)) return;
		this.cleanup(s);
		this.options.onState("idle");
	}

	cancel(): void {
		if (!this.current) return;
		this.cleanup(this.current);
		this.options.onState("idle");
	}
}
