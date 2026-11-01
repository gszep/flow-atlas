import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchPublication } from "./fetch-publication.mjs";
import { verifyRelease } from "./verify-release.mjs";

function entry(path, bytes) {
	return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
async function serve(handler) {
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${server.address().port}/`,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(resolve);
			}),
	};
}

test("publication restore verifies the cache and atomically replaces corrupt payloads", async () => {
	const root = await mkdtemp(join(tmpdir(), "flow-publication-ci-"));
	const data = Buffer.from("published fixture bytes");
	const manifest = { files: [entry("sample/a.fcs", data)] };
	let requests = 0;
	const server = await serve((_request, response) => {
		requests++;
		response.end(data);
	});
	try {
		assert.deepEqual(await fetchPublication(manifest, root, server.url), {
			files: 1,
			downloaded: 1,
		});
		assert.deepEqual(await readFile(join(root, "sample/a.fcs")), data);
		assert.deepEqual(await fetchPublication(manifest, root, server.url), {
			files: 1,
			downloaded: 0,
		});
		assert.equal(requests, 1);
		await writeFile(join(root, "sample/a.fcs"), "bad");
		assert.equal((await fetchPublication(manifest, root, server.url)).downloaded, 1);
		assert.equal(requests, 2);
	} finally {
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("publication restore rejects traversal and incorrect remote bytes without publishing a file", async () => {
	const root = await mkdtemp(join(tmpdir(), "flow-publication-invalid-"));
	const expected = Buffer.from("expected");
	const server = await serve((_request, response) => response.end("tampered"));
	try {
		await assert.rejects(
			fetchPublication({ files: [entry("../outside.fcs", expected)] }, root, server.url),
			/manifest/,
		);
		await assert.rejects(
			fetchPublication({ files: [entry("sample.fcs", expected)] }, root, server.url),
			/mismatch/,
		);
		assert.deepEqual(await readdir(root), []);
	} finally {
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("release verification checks exact source, asset bytes and configured services", async () => {
	const revision = "a".repeat(40);
	const html = Buffer.from("<html>release</html>");
	const script = Buffer.from("console.log('release')");
	const release = {
		source: { gitSha: revision, dirty: false },
		assets: [entry("public/index.html", html), entry("public/assets/app.js", script)],
	};
	let tampered = false;
	let configured = true;
	const server = await serve((request, response) => {
		if (request.url === "/release.json") response.end(JSON.stringify(release));
		else if (request.url === "/api/demo/config")
			response.end(JSON.stringify({ agentConfigured: configured, speechConfigured: configured }));
		else if (request.url === "/index.html") response.end(html);
		else if (request.url === "/assets/app.js") response.end(tampered ? "different" : script);
		else {
			response.statusCode = 404;
			response.end();
		}
	});
	try {
		assert.equal((await verifyRelease(server.url, revision)).verifiedAssets, 2);
		await assert.rejects(verifyRelease(server.url, "b".repeat(40)), /revision/);
		tampered = true;
		await assert.rejects(verifyRelease(server.url, revision), /asset mismatch/);
		tampered = false;
		configured = false;
		await assert.rejects(verifyRelease(server.url, revision), /configuration is missing/);
	} finally {
		await server.close();
	}
});
