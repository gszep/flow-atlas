import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyPublicationArchive } from "./verify-publication-archive.mjs";
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

test("publication archive verification accepts only the pinned bytes", async () => {
	const root = await mkdtemp(join(tmpdir(), "flow-publication-ci-"));
	const data = Buffer.from("published fixture bytes");
	const archive = join(root, "companion.tar.gz");
	const expected = entry("companion.tar.gz", data);
	try {
		await writeFile(archive, data);
		assert.deepEqual(await verifyPublicationArchive(archive, expected), {
			verifiedBytes: data.length,
			sha256: expected.sha256,
		});
		await writeFile(archive, Buffer.alloc(data.length, 65));
		await assert.rejects(verifyPublicationArchive(archive, expected), /hash mismatch/);
		await writeFile(archive, "bad");
		await assert.rejects(verifyPublicationArchive(archive, expected), /size\/type mismatch/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("publication archive verification rejects symlinks and invalid descriptors", async () => {
	const root = await mkdtemp(join(tmpdir(), "flow-publication-invalid-"));
	const data = Buffer.from("expected");
	const archive = join(root, "archive");
	const link = join(root, "link");
	try {
		await writeFile(archive, data);
		await symlink(archive, link);
		await assert.rejects(
			verifyPublicationArchive(link, entry("archive", data)),
			/size\/type mismatch/,
		);
		await assert.rejects(
			verifyPublicationArchive(archive, { bytes: -1, sha256: "bad" }),
			/descriptor/,
		);
		assert.deepEqual(await readFile(archive), data);
	} finally {
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
