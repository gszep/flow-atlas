import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createDemoApi } from "./demo-api.mjs";

// Reuse the repository's existing SDK test dependency, not a second protocol client.
const { Client, StreamableHTTPClientTransport } = createRequire(
	new URL("../packages/host/package.json", import.meta.url),
)("@modelcontextprotocol/client");

test("official MCP client negotiates, lists and calls a browser-backed tool", async () => {
	const handler = createDemoApi({
		env: {
			FLOW_CLAUDE_WORKER_URL: "https://provider.example",
			FLOW_CLAUDE_WORKER_TOKEN: "test-only",
			FLOW_DEMO_ACCESS_CODE: "test-code",
			FLOW_DEMO_ORIGIN: "https://flow.example",
		},
	});
	const server = createServer((req, res) => {
		void handler(req, res);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${server.address().port}`;
	const client = new Client({ name: "flow-demo-test", version: "1" });
	try {
		const session = await (
			await fetch(`${url}/api/demo/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			})
		).json();
		const headers = { authorization: `Bearer ${session.token}` };
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${url}/api/demo/mcp`), {
				requestInit: { headers },
			}),
		);
		assert.equal((await client.listTools()).tools.length, 8);
		const pending = client.callTool({ name: "inspect_dataset", arguments: {} });
		let command;
		for (let attempt = 0; attempt < 50; attempt++) {
			const payload = await (await fetch(`${url}/api/demo/commands`, { headers })).json();
			if (payload.commands.length) {
				command = payload.commands[0];
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(command);
		assert.ok(command.remainingMs > 0 && command.remainingMs <= 45000);
		assert.equal((await fetch(`${url}/api/demo/commands/${command.id}`, { headers })).status, 200);
		await fetch(`${url}/api/demo/results`, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ id: command.id, result: { total: 3, revision: 0 } }),
		});
		const result = await pending;
		assert.deepEqual(JSON.parse(result.content[0].text), { total: 3, revision: 0 });
	} finally {
		await client.close();
		handler.close();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});
