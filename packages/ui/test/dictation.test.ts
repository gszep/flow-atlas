import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dictation } from "../src/dictation.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
const tick = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};

class Socket {
	static OPEN = 1;
	static instances: Socket[] = [];
	readyState = 1;
	bufferedAmount = 0;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	send = vi.fn();
	close = vi.fn(() => {
		this.readyState = 3;
	});
	constructor(
		readonly url: URL,
		readonly protocols: string[],
	) {
		Socket.instances.push(this);
	}
	message(value: unknown) {
		this.onmessage?.({ data: JSON.stringify(value) });
	}
}
class Node {
	connect = vi.fn();
	disconnect = vi.fn();
	gain = { value: 1 };
}
class Worklet extends Node {
	static instances: Worklet[] = [];
	onprocessorerror: (() => void) | null = null;
	port = {
		onmessage: null as ((event: { data: unknown }) => void) | null,
		postMessage: vi.fn(),
		close: vi.fn(),
	};
	constructor() {
		super();
		Worklet.instances.push(this);
	}
	message(data: unknown) {
		this.port.onmessage?.({ data });
	}
}
class Context {
	static instances: Context[] = [];
	state = "running";
	destination = {};
	audioWorklet = { addModule: vi.fn(async () => {}) };
	resume = vi.fn(async () => {});
	close = vi.fn(async () => {
		this.state = "closed";
	});
	createMediaStreamSource = vi.fn(() => new Node());
	createGain = vi.fn(() => new Node());
	constructor(readonly options: unknown) {
		Context.instances.push(this);
	}
}

describe("Dictation relay lifecycle", () => {
	const track = { stop: vi.fn() };
	const stream = { getTracks: () => [track] } as unknown as MediaStream;
	let permission: ReturnType<typeof vi.fn>;
	let fetcher: ReturnType<typeof vi.fn>;
	let client: Dictation;
	let text: ReturnType<typeof vi.fn>;
	let state: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		vi.useFakeTimers();
		Socket.instances = [];
		Worklet.instances = [];
		Context.instances = [];
		track.stop.mockClear();
		permission = vi.fn(async () => stream);
		fetcher = vi.fn(async () => ({
			ok: true,
			json: async () => ({ ticket: "single-use-ticket", expiresAt: Date.now() + 30_000 }),
		}));
		vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: permission } });
		vi.stubGlobal("location", { href: "https://atlas.example/demo" });
		vi.stubGlobal("AudioContext", Context);
		vi.stubGlobal("AudioWorkletNode", Worklet);
		vi.stubGlobal("WebSocket", Socket);
		vi.stubGlobal("fetch", fetcher);
		text = vi.fn();
		state = vi.fn();
		client = new Dictation({ getToken: () => "session-secret", onText: text, onState: state });
	});
	afterEach(() => {
		client.cancel();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});
	async function started() {
		const promise = client.start();
		await tick();
		const socket = Socket.instances[0];
		if (!socket) throw new Error("No socket");
		expect(Worklet.instances).toHaveLength(0);
		socket.message({ type: "Ready" });
		await promise;
		const worklet = Worklet.instances[0];
		if (!worklet) throw new Error("No worklet");
		return { socket, worklet };
	}
	it("requires auth without requesting a microphone or ticket", async () => {
		client = new Dictation({ getToken: () => null, onText: text, onState: state });
		await client.start();
		expect(permission).not.toHaveBeenCalled();
		expect(fetcher).not.toHaveBeenCalled();
		expect(state).toHaveBeenCalledWith("error", expect.stringContaining("Sign in"));
	});
	it("disposes a late permission grant after cancel with no late callbacks", async () => {
		const late = deferred<MediaStream>();
		permission.mockReturnValue(late.promise);
		const start = client.start();
		client.cancel();
		const callbacks = state.mock.calls.length;
		late.resolve(stream);
		await start;
		expect(track.stop).toHaveBeenCalledOnce();
		expect(fetcher).not.toHaveBeenCalled();
		expect(state).toHaveBeenCalledTimes(callbacks);
		expect(Context.instances).toHaveLength(0);
	});
	it("waits for Ready, authenticates only the ticket POST, and mutes monitoring", async () => {
		const { socket } = await started();
		expect(socket.url.href).toBe("wss://atlas.example/api/demo/speech");
		expect(socket.protocols).toEqual(["flow-atlas.dictation", "single-use-ticket"]);
		expect(fetcher).toHaveBeenCalledWith(
			"/api/demo/speech-ticket",
			expect.objectContaining({
				method: "POST",
				body: "{}",
				headers: { Authorization: "Bearer session-secret", "Content-Type": "application/json" },
			}),
		);
		expect(permission).toHaveBeenCalledWith({
			audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
		});
		expect(Context.instances[0]?.options).toEqual({ sampleRate: 16000 });
		expect(Context.instances[0]?.createGain.mock.results[0]?.value.gain.value).toBe(0);
		expect(client.recording).toBe(true);
	});
	it("replaces interim EN/JA text, accumulates finals, and deduplicates segment timing", async () => {
		const { socket } = await started();
		const result = (transcript: string, is_final: boolean, start = 0) =>
			socket.message({
				type: "Results",
				start,
				duration: 1,
				is_final,
				speech_final: is_final,
				channel: { alternatives: [{ transcript }] },
			});
		result("hel", false);
		result("hello", false);
		expect(text).toHaveBeenLastCalledWith("", "hello");
		result("Hello", true);
		result("Hello", true);
		result("こんにちは", false, 1);
		expect(text).toHaveBeenLastCalledWith("Hello", "こんにちは");
		result("こんにちは。", true, 1);
		expect(text).toHaveBeenLastCalledWith("Hello こんにちは。", "");
	});
	it("flushes PCM before Finalize/CloseStream, accepts final results, never submits to AI", async () => {
		const { socket, worklet } = await started();
		const stop = client.stop();
		expect(worklet.port.postMessage).toHaveBeenCalledWith({ type: "flush" });
		expect(socket.send).not.toHaveBeenCalled();
		const pcm = new ArrayBuffer(12);
		worklet.message({ type: "pcm", buffer: pcm });
		worklet.message({ type: "flushed" });
		await tick();
		expect(socket.send.mock.calls.map(([data]) => data)).toEqual([
			pcm,
			'{"type":"Finalize"}',
			'{"type":"CloseStream"}',
		]);
		socket.message({
			type: "Results",
			start: 0,
			duration: 1,
			is_final: true,
			channel: { alternatives: [{ transcript: "final" }] },
		});
		socket.message({ type: "Metadata" });
		await stop;
		expect(text).toHaveBeenLastCalledWith("final", "");
		expect(track.stop).toHaveBeenCalledOnce();
		expect(Context.instances[0]?.close).toHaveBeenCalledOnce();
		expect(worklet.port.close).toHaveBeenCalledOnce();
		expect(socket.close).toHaveBeenCalledOnce();
		expect(state).toHaveBeenLastCalledWith("idle");
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("bounds slow sockets and cleans up rather than buffering audio", async () => {
		const { socket, worklet } = await started();
		socket.bufferedAmount = 128 * 1024;
		worklet.message({ type: "pcm", buffer: new ArrayBuffer(3200) });
		expect(socket.send).not.toHaveBeenCalled();
		expect(track.stop).toHaveBeenCalledOnce();
		expect(state).toHaveBeenLastCalledWith("error", expect.stringContaining("slow"));
	});
	it("ignores a ticket response arriving after cancel and closes the acquired context", async () => {
		const late = deferred<unknown>();
		fetcher.mockReturnValue(late.promise);
		const start = client.start();
		await tick();
		client.cancel();
		const callbacks = state.mock.calls.length;
		late.resolve({ ok: true, json: async () => ({ ticket: "late", expiresAt: 1 }) });
		await start;
		expect(Socket.instances).toHaveLength(0);
		expect(Context.instances[0]?.close).toHaveBeenCalledOnce();
		expect(track.stop).toHaveBeenCalledOnce();
		expect(state).toHaveBeenCalledTimes(callbacks);
	});
	it("ignores worklet module completion after cancellation", async () => {
		const start = client.start();
		await tick();
		const late = deferred<void>();
		Context.instances[0]?.audioWorklet.addModule.mockReturnValue(late.promise);
		Socket.instances[0]?.message({ type: "Ready" });
		await tick();
		client.cancel();
		late.resolve();
		await start;
		expect(Worklet.instances).toHaveLength(0);
		expect(Context.instances[0]?.close).toHaveBeenCalledOnce();
		expect(track.stop).toHaveBeenCalledOnce();
	});
	it("caps recording at sixty seconds and fails safely if the worklet never flushes", async () => {
		const { socket, worklet } = await started();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(client.recording).toBe(false);
		expect(worklet.port.postMessage).toHaveBeenCalledWith({ type: "flush" });
		await vi.advanceTimersByTimeAsync(1000);
		expect(state).toHaveBeenLastCalledWith("error", expect.stringContaining("flush"));
		expect(socket.send).not.toHaveBeenCalledWith('{"type":"Finalize"}');
		expect(track.stop).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("times out final results after three seconds and emits keepalives while recording", async () => {
		const { socket, worklet } = await started();
		await vi.advanceTimersByTimeAsync(4000);
		expect(socket.send).toHaveBeenCalledWith('{"type":"KeepAlive"}');
		const stop = client.stop();
		worklet.message({ type: "flushed" });
		await tick();
		await vi.advanceTimersByTimeAsync(3000);
		await stop;
		expect(track.stop).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("cleans up permission failures and cancellation while waiting for Ready", async () => {
		permission.mockRejectedValueOnce(new Error("denied"));
		await client.start();
		expect(state).toHaveBeenLastCalledWith("error", expect.any(String));
		const start = client.start();
		await tick();
		const socket = Socket.instances[0];
		const lateCallback = socket?.onmessage;
		client.cancel();
		await start;
		lateCallback?.({ data: '{"type":"Ready"}' });
		expect(Worklet.instances).toHaveLength(0);
		expect(socket?.close).toHaveBeenCalledOnce();
		expect(track.stop).toHaveBeenCalledOnce();
	});
});

interface Processor {
	port: { onmessage: (event: { data: { type: string } }) => void };
	process(inputs: Float32Array[][]): boolean;
}
function processor(rate: number) {
	const messages: { type: string; buffer?: ArrayBuffer }[] = [];
	let Constructor!: new () => Processor;
	runInNewContext(readFileSync(new URL("../src/dictation-worklet.js", import.meta.url), "utf8"), {
		sampleRate: rate,
		AudioWorkletProcessor: class {
			port = { postMessage: (data: { type: string; buffer?: ArrayBuffer }) => messages.push(data) };
		},
		registerProcessor: (_name: string, ctor: new () => Processor) => {
			Constructor = ctor;
		},
	});
	return { instance: new Constructor(), messages };
}

describe("audio worklet PCM I/O", () => {
	it("resamples a noninteger 44.1kHz ratio across quantum boundaries", () => {
		const { instance, messages } = processor(44100);
		for (let remaining = 4410; remaining > 0; remaining -= 128) {
			instance.process([[new Float32Array(Math.min(128, remaining)).fill(0.25)]]);
		}
		instance.port.onmessage({ data: { type: "flush" } });
		expect(messages.map((m) => m.type)).toEqual(["pcm", "flushed"]);
		expect(messages[0]?.buffer?.byteLength).toBe(3200);
		expect(new DataView(messages[0]?.buffer as ArrayBuffer).getInt16(3198, true)).toBe(8192);
	});
	it("emits 100ms little-endian PCM16 frames and flushes a partial before its ack", () => {
		const { instance, messages } = processor(16000);
		instance.process([[new Float32Array(1600).fill(-1)]]);
		expect(messages[0]?.buffer?.byteLength).toBe(3200);
		expect(new DataView(messages[0]?.buffer as ArrayBuffer).getInt16(0, true)).toBe(-32768);
		instance.port.onmessage({ data: { type: "ack" } });
		instance.process([[new Float32Array(30).fill(1)]]);
		instance.port.onmessage({ data: { type: "flush" } });
		expect(messages.map((m) => m.type)).toEqual(["pcm", "pcm", "flushed"]);
		expect(messages[1]?.buffer?.byteLength).toBe(60);
		instance.process([[new Float32Array(1600)]]);
		expect(messages).toHaveLength(3);
	});
	it("resamples across render quantum boundaries with bounded output", () => {
		const { instance, messages } = processor(48000);
		for (let i = 0; i < 37; i++) instance.process([[new Float32Array(128).fill(0.5)]]);
		instance.process([[new Float32Array(64).fill(0.5)]]);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.buffer?.byteLength).toBe(3200);
		expect(new DataView(messages[0]?.buffer as ArrayBuffer).getInt16(0, true)).toBe(16384);
		instance.process([[new Float32Array(4800)]]);
		expect(messages.map((m) => m.type)).toEqual(["pcm", "overflow"]);
	});
});
