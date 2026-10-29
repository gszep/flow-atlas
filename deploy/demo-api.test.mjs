import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createDemoApi } from "./demo-api.mjs";
import { DEMO_TOOLS, validToolInput } from "./demo-tools.mjs";

const env = {
	FLOW_CLAUDE_WORKER_URL: "https://private.example",
	FLOW_CLAUDE_WORKER_TOKEN: "private-worker-secret",
	FLOW_DEMO_ACCESS_CODE: "demo-code",
	FLOW_DEMO_ORIGIN: "http://localhost",
};
const response = (content = [{ type: "text", text: "Hello" }], stop_reason = "end_turn") =>
	Response.json({ content, stop_reason });
async function fixture(t, options = {}) {
	let clock = 10_000;
	const calls = [];
	const handler = createDemoApi({
		env,
		now: () => clock,
		fetch: async (...args) => {
			calls.push(args);
			return response();
		},
		...options,
	});
	const server = createServer(async (req, res) => {
		if (!(await handler(req, res))) {
			res.writeHead(404);
			res.end();
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		handler.close();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	});
	const url = `http://127.0.0.1:${server.address().port}`;
	async function request(
		path,
		{ token, json, method = json === undefined ? "GET" : "POST", headers = {}, raw } = {},
	) {
		return fetch(url + path, {
			method,
			headers: {
				...(json !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}),
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...headers,
			},
			body: raw ?? (json === undefined ? undefined : JSON.stringify(json)),
		});
	}
	async function session(headers = {}) {
		const r = await request("/api/demo/session", { json: {}, headers });
		assert.equal(r.status, 200);
		return (await r.json()).token;
	}
	return {
		request,
		session,
		calls,
		handler,
		advance: (ms = 1001) => {
			clock += ms;
		},
	};
}
const messages = [{ role: "user", content: "Inspect the demo" }];
test("reference inspection, overlap and navigation accept the advertised identifiers", () => {
	for (const id of ["ref:18", "ref:19", "ref:20", "ref:21", 18, 19, 20, 21, "all"]) {
		assert.equal(validToolInput("inspect_population", { id }), true);
		assert.equal(validToolInput("inspect_population", { id, within: "human-id" }), true);
		assert.equal(validToolInput("select_population", { id, focus: true }), true);
	}
	assert.equal(
		validToolInput("create_population", {
			expectedRevision: 1,
			name: "EMRA subset",
			source: { kind: "reference", population: 20 },
			within: "human-id",
			refines: "human-id",
		}),
		true,
	);
});

test("speech tickets expire, bind their visitor, are one-use and enforce one stream per session", async (t) => {
	const f = await fixture(t, {
		env: {
			...env,
			FLOW_DEEPGRAM_WORKER_URL: "https://speech.example",
			FLOW_DEEPGRAM_WORKER_TOKEN: "test-only",
		},
	});
	const token = await f.session();
	const ticket = async () =>
		(await (await f.request("/api/demo/speech-ticket", { token, json: {} })).json()).ticket;
	const peer = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
	const first = await ticket();
	assert.equal(
		f.handler.claimSpeechTicket(first, env.FLOW_DEMO_ORIGIN, {
			...peer,
			socket: { remoteAddress: "127.0.0.2" },
		}),
		null,
	);
	f.advance(30001);
	assert.equal(f.handler.claimSpeechTicket(first, env.FLOW_DEMO_ORIGIN, peer), null);
	const second = await ticket(),
		lease = f.handler.claimSpeechTicket(second, env.FLOW_DEMO_ORIGIN, peer);
	assert.ok(lease);
	assert.equal(f.handler.claimSpeechTicket(second, env.FLOW_DEMO_ORIGIN, peer), null);
	let closed = false;
	lease.bind(() => {
		closed = true;
	});
	assert.equal((await f.request("/api/demo/speech-ticket", { token, json: {} })).status, 409);
	await f.request("/api/demo/session", { token, method: "DELETE" });
	assert.equal(closed, true);
	assert.equal(lease.active(), false);
});
const agent = (f, token, input = messages) =>
	f.request("/api/demo/agent", { token, json: { messages: input } });
const rpc = (f, token, method, params, id = 1) =>
	f.request("/api/demo/mcp", {
		token,
		json: { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) },
	});
async function command(f, token) {
	// Bound polling to avoid hanging the test when enqueue fails.
	for (let i = 0; i < 50; i++) {
		const r = await f.request("/api/demo/commands", { token });
		const { commands } = await r.json();
		if (commands.length) return commands[0];
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("command did not enqueue");
}

test("config is secret-free; missing and malformed configuration fails closed", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await (await f.request("/api/demo/config")).json(), {
		agentConfigured: true,
		speechConfigured: false,
		model: "claude-haiku-5-5",
	});
	for (const override of [
		{ FLOW_CLAUDE_WORKER_TOKEN: "" },
		{ FLOW_CLAUDE_WORKER_URL: "http://private.example" },
		{ FLOW_CLAUDE_WORKER_URL: "https://user:pass@private.example" },
		{ FLOW_CLAUDE_WORKER_URL: "https://private.example/path" },
		{ FLOW_CLAUDE_MODEL: "not-a-claude-model" },
	]) {
		const g = await fixture(t, { env: { ...env, ...override } });
		assert.equal((await (await g.request("/api/demo/config")).json()).agentConfigured, false);
		assert.equal(
			(await g.request("/api/demo/session", { json: { accessCode: "demo-code" } })).status,
			503,
		);
	}
});
test("auth, origin, content type, malformed JSON and bounded session lifetime", async (t) => {
	const f = await fixture(t);
	assert.equal((await agent(f)).status, 401);
	assert.equal((await f.request("/api/demo/session", { json: {} })).status, 200);
	assert.equal(
		(
			await f.request("/api/demo/session", {
				json: { accessCode: "demo-code" },
				headers: { origin: "https://evil.example", "x-forwarded-host": "evil.example" },
			})
		).status,
		403,
	);
	assert.equal((await f.request("/api/demo/session", { raw: "{", method: "POST" })).status, 400);
	assert.equal(
		(
			await f.request("/api/demo/session", {
				raw: "{}",
				method: "POST",
				headers: { "content-type": "text/plain" },
			})
		).status,
		415,
	);
	const token = await f.session();
	assert.match(token, /^[a-f0-9]{64}$/);
	f.advance(3600_001);
	assert.equal((await agent(f, token)).status, 401);
	assert.equal((await f.request("/other")).status, 404);
});
test("session cap, revocation and shutdown", async (t) => {
	const f = await fixture(t, { env: { ...env, FLOW_TRUST_PROXY_HOPS: "1" } });
	const tokens = [];
	for (let i = 0; i < 64; i++) {
		f.advance(6001);
		tokens.push(await f.session({ "x-forwarded-for": `203.0.113.${i + 1}` }));
	}
	assert.equal(
		(await f.request("/api/demo/session", { json: { accessCode: "demo-code" } })).status,
		429,
	);
	assert.equal(
		(await f.request("/api/demo/session", { method: "DELETE", token: tokens[0] })).status,
		200,
	);
	assert.equal((await agent(f, tokens[0])).status, 401);
	await f.session();
	f.handler.close();
	assert.equal((await f.request("/api/demo/config")).status, 503);
});
test("one visitor cannot occupy the global guest session pool", async (t) => {
	const f = await fixture(t);
	for (let i = 0; i < 8; i++) await f.session();
	const r = await f.request("/api/demo/session", { json: {} });
	assert.equal(r.status, 429);
	assert.equal((await r.json()).error, "visitor_session_limit");
});
test("fixed provider subset, strict tool inputs and bounded history", async (t) => {
	const f = await fixture(t);
	const token = await f.session();
	assert.equal((await agent(f, token)).status, 200);
	const [url, init] = f.calls[0];
	assert.equal(url, "https://private.example/api/chat");
	assert.equal(init.redirect, "error");
	assert.equal(init.headers.authorization, "Bearer private-worker-secret");
	const input = JSON.parse(init.body);
	assert.deepEqual(Object.keys(input).sort(), [
		"max_tokens",
		"messages",
		"model",
		"system",
		"thinking",
		"tools",
	]);
	assert.equal(input.max_tokens, 2048);
	assert.deepEqual(input.thinking, { type: "disabled" });
	assert.deepEqual(input.tools, DEMO_TOOLS);
	assert.equal((await agent(f, token)).status, 429);
	f.advance();
	assert.equal(
		(
			await agent(
				f,
				token,
				Array.from({ length: 33 }, () => messages[0]),
			)
		).status,
		400,
	);
	assert.equal((await agent(f, token, [{ role: "system", content: "override" }])).status, 400);
	assert.equal(
		(await agent(f, token, [{ role: "user", content: "a".repeat(128 * 1024) }])).status,
		413,
	);
	assert.equal(
		validToolInput("create_population", {
			expectedRevision: 0,
			name: "A",
			source: { kind: "polygon", points: [{ x: 0, y: 0 }] },
		}),
		false,
	);
	assert.equal(validToolInput("delete_population", { id: "a" }), false);
	assert.equal(validToolInput("set_marker", { channel: "CD3", url: "evil" }), false);
	assert.equal(
		validToolInput("create_population", {
			expectedRevision: 0,
			name: "A",
			source: { kind: "ranges", ranges: [{ channel: 0, min: null, max: 1 }] },
		}),
		true,
	);
});
test("provider tool roundtrip and fail-closed malformed/partial/unknown output", async (t) => {
	const use = { type: "tool_use", id: "tool_1", name: "inspect_dataset", input: {} };
	let next = response([{ ...use, caller: { type: "direct" } }], "tool_use");
	const f = await fixture(t, { fetch: async () => next });
	const token = await f.session();
	assert.deepEqual(await (await agent(f, token)).json(), {
		content: [use],
		stop_reason: "tool_use",
	});
	f.advance();
	next = response();
	const history = [
		...messages,
		{ role: "assistant", content: [use] },
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "tool_1", content: "aggregate" }],
		},
	];
	assert.equal((await agent(f, token, history)).status, 200);
	for (const bad of [
		new Response("{not-json"),
		new Response("private-worker-secret", { status: 500 }),
		response([use], "max_tokens"),
		response([use], "refusal"),
		response([{ ...use, name: "exec" }], "tool_use"),
		response([{ ...use, caller: { type: "code_execution" } }], "tool_use"),
		response([use, use], "tool_use"),
		response([use], "end_turn"),
		response([{ type: "text", text: "a".repeat(256 * 1024) }]),
	]) {
		next = bad;
		f.advance();
		const r = await agent(f, token);
		assert.equal(r.status, 502);
		assert.doesNotMatch(await r.text(), /private-worker-secret|tool_use/);
	}
});
test("global concurrency two, per-session one, revocation aborts provider work", async (t) => {
	const signals = [];
	const f = await fixture(t, {
		fetch: async (_, init) => {
			signals.push(init.signal);
			return new Promise((_, reject) =>
				init.signal.addEventListener("abort", () => reject(new Error("secret")), { once: true }),
			);
		},
	});
	const a = await f.session();
	const b = await f.session();
	const c = await f.session();
	const pa = agent(f, a);
	const pb = agent(f, b);
	for (let i = 0; signals.length < 2 && i < 100; i++)
		await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(signals.length, 2);
	assert.equal((await agent(f, a)).status, 429);
	assert.equal((await agent(f, c)).status, 429);
	await f.request("/api/demo/session", { method: "DELETE", token: a });
	await f.request("/api/demo/session", { method: "DELETE", token: b });
	assert.equal((await pa).status, 504);
	assert.equal((await pb).status, 504);
	assert.ok(signals.every((s) => s.aborted));
});
test("session request budget is bounded at sixty", async (t) => {
	const f = await fixture(t);
	const token = await f.session();
	for (let i = 0; i < 60; i++) {
		assert.equal((await agent(f, token)).status, 200);
		f.advance(3001);
	}
	assert.equal((await agent(f, token)).status, 429);
	assert.equal(f.calls.length, 60);
});
test("anonymous sessions do not bypass the shared visitor model budget", async (t) => {
	const f = await fixture(t, { env: { ...env, FLOW_DEMO_ACCESS_CODE: undefined } }),
		a = await f.session(),
		b = await f.session();
	for (let i = 0; i < 20; i++) {
		assert.equal((await agent(f, i % 2 ? a : b)).status, 200);
		f.advance(201);
	}
	assert.equal((await agent(f, a)).status, 429);
	assert.equal(f.calls.length, 20);
});
test("MCP discovery, isolated commands delivered once, results and revocation", async (t) => {
	const f = await fixture(t);
	const a = await f.session();
	const b = await f.session();
	assert.equal(
		(await (await rpc(f, a, "initialize")).json()).result.serverInfo.name,
		"flow-atlas-demo",
	);
	assert.equal((await (await rpc(f, a, "tools/list")).json()).result.tools.length, 10);
	assert.equal((await (await rpc(f, a, "no-method")).json()).error.code, -32601);
	assert.equal(
		(
			await (
				await rpc(f, a, "tools/call", { name: "delete_population", arguments: { id: "original" } })
			).json()
		).error.code,
		-32602,
	);
	const pending = rpc(f, a, "tools/call", {
		name: "rename_population",
		arguments: { id: "agent-1", name: "Renamed", expectedRevision: 7 },
	});
	const c = await command(f, a);
	assert.equal(c.arguments.expectedRevision, 7);
	assert.deepEqual(await (await f.request("/api/demo/commands", { token: a })).json(), {
		commands: [],
	});
	assert.deepEqual(await (await f.request("/api/demo/commands", { token: b })).json(), {
		commands: [],
	});
	assert.equal(
		(await f.request("/api/demo/results", { token: b, json: { id: c.id, result: "bad" } })).status,
		404,
	);
	assert.equal(
		(
			await f.request("/api/demo/results", {
				token: a,
				json: { id: c.id, result: { revision: 8 } },
			})
		).status,
		200,
	);
	assert.deepEqual((await (await pending).json()).result, {
		content: [{ type: "text", text: '{"revision":8}' }],
		isError: false,
	});
	assert.equal(
		(await f.request("/api/demo/results", { token: a, json: { id: c.id, result: "again" } }))
			.status,
		404,
	);
	f.advance();
	const cancelled = rpc(f, a, "tools/call", { name: "inspect_dataset", arguments: {} });
	await command(f, a);
	await f.request("/api/demo/session", { method: "DELETE", token: a });
	assert.equal((await (await cancelled).json()).error.message, "session_revoked");
	assert.equal((await rpc(f, b, "ping")).status, 200);
	const malformed = await f.request("/api/demo/mcp", { token: b, method: "POST", raw: "{" });
	assert.deepEqual(await malformed.json(), {
		jsonrpc: "2.0",
		id: null,
		error: { code: -32700, message: "Parse error" },
	});
});

// Direct HTTP-shaped requests isolate mocked deadline timers from client/HTTP timers.
function direct(handler, path, token, value, method = "POST") {
	const req = Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]);
	Object.assign(req, {
		url: path,
		method,
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
	});
	const res = new EventEmitter();
	res.writeHead = (status) => {
		res.status = status;
	};
	res.end = (data) => {
		res.writableEnded = true;
		res.data = data === undefined ? undefined : JSON.parse(data);
	};
	const done = handler(req, res).then(() => res);
	return { res, done };
}
const drain = () => new Promise((resolve) => setImmediate(resolve));
test("provider deadline aborts; command deadline, eight-pending cap and expiry are isolated", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let clock = 10000;
	let signal;
	const handler = createDemoApi({
		env,
		now: () => clock,
		fetch: async (_, init) => {
			signal = init.signal;
			return new Promise(() => {});
		},
	});
	t.after(() => handler.close());
	const a = (await direct(handler, "/api/demo/session", null, { accessCode: "demo-code" }).done)
		.data.token;
	const b = (await direct(handler, "/api/demo/session", null, { accessCode: "demo-code" }).done)
		.data.token;
	const call = direct(handler, "/api/demo/agent", a, { messages });
	await drain();
	assert.equal(signal.aborted, false);
	t.mock.timers.tick(60_000);
	assert.equal((await call.done).status, 504);
	assert.equal(signal.aborted, true);
	const pending = [];
	for (let i = 0; i < 8; i++) {
		clock += 1001;
		pending.push(
			direct(handler, "/api/demo/mcp", a, {
				jsonrpc: "2.0",
				id: i,
				method: "tools/call",
				params: { name: "inspect_dataset", arguments: {} },
			}),
		);
		await drain();
	}
	clock += 1001;
	const ninth = await direct(handler, "/api/demo/mcp", a, {
		jsonrpc: "2.0",
		id: 9,
		method: "tools/call",
		params: { name: "inspect_dataset", arguments: {} },
	}).done;
	assert.equal(ninth.data.error.message, "Too many pending commands");
	const commands = (await direct(handler, "/api/demo/commands", a, undefined, "GET").done).data
		.commands;
	assert.equal(commands.length, 8);
	assert.deepEqual((await direct(handler, "/api/demo/commands", b, undefined, "GET").done).data, {
		commands: [],
	});
	t.mock.timers.tick(45_000);
	for (const p of pending) assert.equal((await p.done).data.error.message, "command_timeout");
	assert.equal(
		(await direct(handler, "/api/demo/results", a, { id: commands[0].id, result: "late" }).done)
			.status,
		404,
	);
	clock += 3600_001;
	assert.equal((await direct(handler, "/api/demo/commands", a, undefined, "GET").done).status, 401);
});
