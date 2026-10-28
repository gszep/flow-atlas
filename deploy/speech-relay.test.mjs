import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { createDemoApi } from "./demo-api.mjs";
import { attachSpeechRelay } from "./speech-relay.mjs";

async function fixture(t, overrides = {}, relayOptions = {}) {
	const env = {
		FLOW_CLAUDE_WORKER_URL: "https://claude.example",
		FLOW_CLAUDE_WORKER_TOKEN: "claude-private",
		FLOW_DEMO_ACCESS_CODE: "demo-code",
		FLOW_DEMO_ORIGIN: "https://flow.example",
		FLOW_DEEPGRAM_WORKER_URL: "https://speech.example",
		FLOW_DEEPGRAM_WORKER_TOKEN: "speech-private",
		...overrides,
	};
	const received = [],
		requests = [];
	const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await once(upstream, "listening");
	upstream.on("connection", (socket) => {
		socket.on("message", (data, binary) => {
			received.push({ binary, data });
			if (binary)
				socket.send(
					JSON.stringify({
						type: "Results",
						is_final: false,
						channel: { alternatives: [{ transcript: "hello 日本語" }] },
					}),
				);
			else if (JSON.parse(data.toString()).type === "CloseStream") {
				socket.send(
					JSON.stringify({
						type: "Results",
						is_final: true,
						channel: { alternatives: [{ transcript: "hello 日本語" }] },
					}),
				);
				socket.close(1000);
			}
		});
	});
	const api = createDemoApi({ env });
	const server = createServer(async (req, res) => {
		if (!(await api(req, res))) {
			res.writeHead(404);
			res.end();
		}
	});
	const relay = attachSpeechRelay(server, api, {
		env,
		...relayOptions,
		connect: (url, options) => {
			requests.push({ url: String(url), options });
			return new WebSocket(`ws://127.0.0.1:${upstream.address().port}`, options);
		},
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${server.address().port}`;
	const post = (path, token, value = {}) =>
		fetch(base + path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(value),
		});
	const session = async () =>
		(await (await post("/api/demo/session", null, { accessCode: "demo-code" })).json()).token;
	const ticket = async (token) => {
		const r = await post("/api/demo/speech-ticket", token);
		assert.equal(r.status, 200);
		return (await r.json()).ticket;
	};
	const socket = (value, origin = env.FLOW_DEMO_ORIGIN) =>
		new WebSocket(
			`${base.replace("http:", "ws:")}/api/demo/speech`,
			["flow-atlas.dictation", value],
			{ origin },
		);
	t.after(async () => {
		relay.close();
		api.close();
		for (const socket of upstream.clients) socket.terminate();
		await new Promise((r) => upstream.close(r));
		server.closeAllConnections();
		await new Promise((r) => server.close(r));
	});
	return { env, post, session, ticket, socket, received, requests, api, base };
}

test("single-use ticket relays bounded PCM and final EN/JA results without exposing the Worker token", async (t) => {
	const f = await fixture(t),
		token = await f.session(),
		ticket = await f.ticket(token);
	const socket = f.socket(ticket),
		messages = [];
	socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
	await once(socket, "message");
	assert.equal(messages[0].type, "Ready");
	const endpoint = new URL(f.requests[0].url);
	assert.equal(endpoint.origin, "wss://speech.example");
	assert.equal(endpoint.searchParams.get("store"), "false");
	assert.equal(endpoint.searchParams.get("mip_opt_out"), "true");
	assert.equal(endpoint.searchParams.get("sample_rate"), "16000");
	assert.equal(f.requests[0].options.headers.Authorization, "Token speech-private");
	socket.send(Buffer.alloc(3200));
	await once(socket, "message");
	socket.send(JSON.stringify({ type: "Finalize" }));
	socket.send(JSON.stringify({ type: "CloseStream" }));
	await once(socket, "close");
	assert.equal(
		messages.find((m) => m.is_final)?.channel.alternatives[0].transcript,
		"hello 日本語",
	);
	assert.doesNotMatch(JSON.stringify(messages), /speech-private|claude-private/);
	const replay = f.socket(ticket);
	replay.on("error", () => {});
	const [error] = await once(replay, "error");
	assert.match(error.message, /401/);
});

test("wrong origin is rejected; revoking the session closes its speech stream", async (t) => {
	const f = await fixture(t),
		token = await f.session(),
		ticket = await f.ticket(token);
	const invalid = f.socket(ticket, "https://other.example");
	invalid.on("error", () => {});
	const [error] = await once(invalid, "error");
	assert.match(error.message, /401/);
	const valid = f.socket(ticket);
	await once(valid, "message");
	const closed = once(valid, "close");
	await fetch(`${f.base}/api/demo/session`, {
		method: "DELETE",
		headers: { authorization: `Bearer ${token}` },
	});
	await closed;
});

test("dictation switch disables ticket minting and visitor starts are limited across sessions", async (t) => {
	const off = await fixture(t, { FLOW_DICTATION_ENABLED: "false" }),
		token = await off.session();
	assert.equal((await off.post("/api/demo/speech-ticket", token)).status, 503);
	const on = await fixture(t),
		a = await on.session(),
		b = await on.session();
	for (let i = 0; i < 6; i++) {
		const response = await on.post("/api/demo/speech-ticket", i % 2 ? a : b);
		assert.equal(response.status, 200);
		await new Promise((r) => setTimeout(r, 205));
	}
	assert.equal((await on.post("/api/demo/speech-ticket", a)).status, 429);
});

test("oversized PCM and arbitrary upstream controls are rejected", async (t) => {
	const f = await fixture(t),
		token = await f.session();
	const a = f.socket(await f.ticket(token));
	await once(a, "message");
	a.send(Buffer.alloc(6402));
	await once(a, "close");
	assert.equal(f.received.length, 0);
	await new Promise((r) => setTimeout(r, 205));
	const b = f.socket(await f.ticket(token));
	await once(b, "message");
	b.send(JSON.stringify({ type: "Configure", store: true }));
	await once(b, "close");
	assert.equal(f.received.length, 0);
});

test("only two concurrent relay streams can open", async (t) => {
	const f = await fixture(t),
		streams = [];
	for (let i = 0; i < 2; i++) {
		const socket = f.socket(await f.ticket(await f.session()));
		streams.push(socket);
		await once(socket, "message");
	}
	const rejected = f.socket(await f.ticket(await f.session()));
	rejected.on("error", () => {});
	const [error] = await once(rejected, "error");
	assert.match(error.message, /429/);
	assert.equal(f.requests.length, 2);
	for (const socket of streams) socket.close();
});

test("the stream deadline closes an idle connection and releases its session slot", async (t) => {
	const f = await fixture(t, {}, { maxStreamMs: 100 }),
		token = await f.session();
	const socket = f.socket(await f.ticket(token));
	await once(socket, "message");
	const [code] = await once(socket, "close");
	assert.equal(code, 1000);
	await new Promise((resolve) => setTimeout(resolve, 205));
	assert.equal((await f.post("/api/demo/speech-ticket", token)).status, 200);
});
