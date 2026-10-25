/**
 * Deploy-package tests: real HTTP against the actual static server on an
 * ephemeral port, plus prepare.mjs staging/verification against fixture
 * directories. Node built-in test runner only; zero external dependencies.
 * All fixtures are private and removed afterwards; nothing is copied as a
 * workaround — the implementation is exercised as staged.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createStaticServer } from "./static-server.mjs";

const roots = [];
const servers = [];
const children = [];

async function fixtureRoot(prefix) {
	const root = await mkdtemp(join(tmpdir(), `flow-atlas-deploy-${prefix}-`));
	roots.push(root);
	return root;
}

/** Private fixture tree with deliberately hostile entries the server must never serve. */
async function buildServerFixture() {
	const root = await fixtureRoot("server");
	const publicRoot = join(root, "public");
	await mkdir(join(publicRoot, "assets"), { recursive: true });
	await writeFile(
		join(publicRoot, "index.html"),
		'<!doctype html><html><body><script type="module" src="./assets/app-abc12345.js"></script><link rel="stylesheet" href="./styles.css"></body></html>',
	);
	await writeFile(
		join(publicRoot, "assets", "app-abc12345.js"),
		'export const demo = "flow-atlas";\n',
	);
	await writeFile(join(publicRoot, "styles.css"), "body { color: currentcolor }\n");
	await writeFile(join(publicRoot, "secret.fcs"), "FCS3.1 private corpus bytes");
	await writeFile(join(publicRoot, ".hidden"), "hidden dotfile");
	await writeFile(join(publicRoot, "assets", ".env"), "SECRET=1");
	await writeFile(join(root, "outside-secrets.txt"), "outside the public root");
	await symlink(join(root, "outside-secrets.txt"), join(publicRoot, "link.css"));
	await writeFile(
		join(root, "release.json"),
		JSON.stringify({ schemaVersion: 1, source: { gitSha: "f".repeat(64) }, assets: [] }),
	);
	return root;
}

function startServer(fixture) {
	return listenEphemeral(join(fixture, "public"), join(fixture, "release.json"));
}

function listenEphemeral(publicRoot, releasePath) {
	const server = createStaticServer({ publicRoot, releasePath, log: () => {} });
	servers.push(server);
	return new Promise((ready) => {
		server.listen(0, "127.0.0.1", () => ready(server));
	});
}

const base = (server) => `http://127.0.0.1:${server.address().port}`;

async function expectStatus(server, path, method = "GET") {
	const response = await fetch(`${base(server)}${path}`, { method, redirect: "manual" });
	return { response, body: method === "HEAD" ? "" : await response.text() };
}

after(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
	}
	for (const server of servers.splice(0)) {
		await new Promise((done) => server.close(done));
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("static server confinement and caching", () => {
	it("serves the index with no-store, security headers and the runtime version", async () => {
		const fixture = await buildServerFixture();
		const server = await startServer(fixture);
		const { response, body } = await expectStatus(server, "/");
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type"), /text\/html/);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
		assert.match(response.headers.get("x-flow-atlas-runtime"), /^node\/v\d/);
		assert.ok(body.includes("./assets/app-abc12345.js"));
	});

	it("serves hashed assets immutable and plain assets revalidating with correct MIME", async () => {
		const fixture = await buildServerFixture();
		const server = await startServer(fixture);
		const script = await expectStatus(server, "/assets/app-abc12345.js");
		assert.equal(script.response.status, 200);
		assert.match(script.response.headers.get("content-type"), /text\/javascript/);
		assert.match(script.response.headers.get("cache-control"), /immutable/);
		const stylesheet = await expectStatus(server, "/styles.css");
		assert.equal(stylesheet.response.status, 200);
		assert.match(stylesheet.response.headers.get("content-type"), /text\/css/);
		assert.equal(stylesheet.response.headers.get("cache-control"), "no-cache");
	});

	it("serves release.json from the package root with no-store", async () => {
		const fixture = await buildServerFixture();
		const server = await startServer(fixture);
		const { response, body } = await expectStatus(server, "/release.json");
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type"), /application\/json/);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(JSON.parse(body).source.gitSha, "f".repeat(64));
	});

	it("answers 404 plainly for unknown routes, APIs, dotfiles, disallowed files, listings and symlinks", async () => {
		const fixture = await buildServerFixture();
		const server = await startServer(fixture);
		for (const path of [
			"/missing.txt",
			"/rpc",
			"/mcp",
			"/rpc/stream",
			"/.hidden",
			"/public/.hidden",
			"/assets/.env",
			"/secret.fcs",
			"/assets/",
			"/assets",
			"/link.css",
			"/outside-secrets.txt",
			"/release.json/",
		]) {
			const { response, body } = await expectStatus(server, path);
			assert.equal(response.status, 404, path);
			assert.equal(body, "Not found", path);
			assert.ok(!body.includes("/"), `no path echo for ${path}`);
		}
	});

	it("blocks single- and double-decoded traversal in every form", async () => {
		const fixture = await buildServerFixture();
		const server = await startServer(fixture);
		for (const path of [
			"/%2e%2e/outside-secrets.txt",
			"/..%2foutside-secrets.txt",
			"/assets/%2e%2e/%2e%2e/outside-secrets.txt",
			"/a%2f%2e%2e%2foutside-secrets.txt",
			"/..%5coutside-secrets.txt",
			"/%2e%2e%2fout%2e%2e%2fmore",
		]) {
			const { response, body } = await expectStatus(server, path);
			assert.ok(
				response.status === 400 || response.status === 404,
				`${path} -> ${response.status}`,
			);
			assert.ok(!body.includes("outside"), `${path} leaked content`);
		}
		// A raw two-dot segment cannot even be requested unencoded through a URL parser
		// without normalization, but explicit percent forms above prove the guard.
		const direct = await expectStatus(server, "/../outside-secrets.txt");
		assert.ok(direct.response.status === 400 || direct.response.status === 404);
	});

	it("allows only GET and HEAD with a plain 405 otherwise", async () => {
		const fixture = await buildServerFixture();
		const server = await startServer(fixture);
		for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
			const response = await fetch(`${base(server)}/`, { method });
			assert.equal(response.status, 405, method);
			assert.equal(response.headers.get("allow"), "GET, HEAD");
			assert.equal(await response.text(), "Method not allowed");
		}
	});

	it("answers HEAD without a body but with the full metadata", async () => {
		const fixture = await buildServerFixture();
		const server = await startServer(fixture);
		const response = await fetch(`${base(server)}/`, { method: "HEAD" });
		assert.equal(response.status, 200);
		assert.ok(Number(response.headers.get("content-length")) > 0);
		assert.equal(await response.text(), "");
	});

	it("rejects malformed percent encodings with a plain 400", async () => {
		const fixture = await buildServerFixture();
		const server = await startServer(fixture);
		for (const path of ["/%", "/%zz", "/assets/%2"]) {
			const { response, body } = await expectStatus(server, path);
			assert.equal(response.status, 400, path);
			assert.equal(body, "Bad request");
		}
	});

	it("keeps relative UI asset references working from the served index", async () => {
		const fixture = await buildServerFixture();
		const server = await startServer(fixture);
		const index = await (await fetch(`${base(server)}/`)).text();
		const reference = index.match(/src="(\.\/assets\/[^"]+)"/)?.[1];
		assert.ok(reference, "fixture index must reference a relative asset");
		const response = await fetch(`${base(server)}/${reference.slice(2)}`);
		assert.equal(response.status, 200);
	});

	it("serves a directly requested index.html identically to /", async () => {
		const fixture = await buildServerFixture();
		const server = await startServer(fixture);
		const direct = await expectStatus(server, "/index.html");
		assert.equal(direct.response.status, 200);
		assert.equal(direct.response.headers.get("cache-control"), "no-store");
	});
});

describe("prepare staging and verification", () => {
	const repoRoot = new URL("..", import.meta.url).pathname;
	const prepare = (args) =>
		new Promise((resolvePromise) => {
			execFile(
				process.execPath,
				[join(repoRoot, "deploy", "prepare.mjs"), ...args],
				{ cwd: repoRoot, encoding: "utf8" },
				(error, stdout, stderr) => resolvePromise({ code: error?.code ?? 0, stdout, stderr }),
			);
		});

	async function buildDistFixture(withHostile = true) {
		const root = await fixtureRoot("dist");
		const dist = join(root, "dist");
		await mkdir(join(dist, "assets"), { recursive: true });
		await writeFile(
			join(dist, "index.html"),
			'<!doctype html><script src="./assets/app-abc12345.js"></script>',
		);
		await writeFile(join(dist, "assets", "app-abc12345.js"), "export const demo = 1;\n");
		await writeFile(join(dist, "assets", "logo-a1b2c3d4.svg"), "<svg/>");
		if (withHostile) {
			await writeFile(join(dist, "corpus.fcs"), "private bytes");
			await writeFile(join(dist, ".env"), "SECRET=1");
			await mkdir(join(dist, "oracle"), { recursive: true });
			await writeFile(join(dist, "oracle", "x.fcs"), "more private");
		}
		return dist;
	}

	it("stages allowlisted assets plus server files and verifies a real git HEAD manifest", async () => {
		const dist = await buildDistFixture(false);
		const destination = await fixtureRoot("package");
		const outcome = await prepare([destination, "--ui-dist", dist]);
		assert.equal(outcome.code, 0, outcome.stderr);
		const staged = await readdir(destination);
		assert.deepEqual(staged.sort(), [
			"package.json",
			"public",
			"release.json",
			"static-server.mjs",
		]);
		const release = JSON.parse(await readFile(join(destination, "release.json"), "utf8"));
		const head = await new Promise((resolvePromise, rejectPromise) =>
			execFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot }, (error, stdout) =>
				error ? rejectPromise(error) : resolvePromise(stdout.trim()),
			),
		);
		assert.equal(release.source.gitSha, head);
		assert.equal(typeof release.source.branch, "string");
		assert.equal(typeof release.source.dirty, "boolean");
		const manifestPaths = release.assets.map((asset) => asset.path).sort();
		assert.deepEqual(manifestPaths, [
			"package.json",
			"public/assets/app-abc12345.js",
			"public/assets/logo-a1b2c3d4.svg",
			"public/index.html",
			"static-server.mjs",
		]);
		for (const asset of release.assets) {
			const bytes = await readFile(join(destination, asset.path));
			assert.equal(asset.bytes, bytes.byteLength, asset.path);
			assert.equal(asset.sha256, createHash("sha256").update(bytes).digest("hex"), asset.path);
		}
		// The staged package is self-contained and serves from its own staged layout.
		const probe = await listenEphemeral(
			join(destination, "public"),
			join(destination, "release.json"),
		);
		const response = await fetch(`${base(probe)}/`);
		assert.equal(response.status, 200);
		assert.ok((await response.text()).includes("./assets/app-abc12345.js"));
	});

	it("launches the staged server from its own directory with PORT/HOST", async () => {
		const dist = await buildDistFixture(false);
		const destination = await fixtureRoot("package-spawn");
		const first = await prepare([destination, "--ui-dist", dist]);
		assert.equal(first.code, 0, first.stderr);
		// Pick a free port by binding and closing a probe socket.
		const port = await new Promise((ready) => {
			const probe = createServer();
			probe.listen(0, "127.0.0.1", () => {
				const picked = probe.address().port;
				probe.close(() => ready(picked));
			});
		});
		const child = spawn(process.execPath, ["static-server.mjs"], {
			cwd: destination,
			env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.push(child);
		let output = "";
		child.stdout.on("data", (chunk) => (output += chunk));
		child.stderr.on("data", (chunk) => (output += chunk));
		try {
			let served = false;
			for (let attempt = 0; attempt < 50 && !served; attempt++) {
				await new Promise((pause) => setTimeout(pause, 100));
				try {
					const response = await fetch(`http://127.0.0.1:${port}/release.json`);
					if (response.ok) {
						const release = await response.json();
						assert.equal(response.headers.get("cache-control"), "no-store");
						assert.match(release.source.gitSha, /^[a-f0-9]{40}$/);
						served = true;
					}
				} catch {
					// not listening yet
				}
			}
			assert.ok(served, `staged server never answered; output: ${output}`);
			assert.match(output, /listening on 127\.0\.0\.1:\d+/);
			const index = await fetch(`http://127.0.0.1:${port}/`);
			assert.equal(index.status, 200);
		} finally {
			child.kill("SIGTERM");
		}
	});

	it("refuses private content, symlinks, mismatched revisions and dirty destinations", async () => {
		const hostile = await buildDistFixture(true);
		const destination = await fixtureRoot("package-hostile");
		const outcome = await prepare([destination, "--ui-dist", hostile]);
		assert.notEqual(outcome.code, 0);
		assert.match(outcome.stderr, /forbidden|not allowlisted|dotfile/);
		const leftovers = await readdir(join(destination, "public")).catch(() => []);
		assert.ok(!leftovers.some((name) => name.endsWith(".fcs")));

		const linked = await fixtureRoot("dist-link");
		await mkdir(join(linked, "dist"), { recursive: true });
		await writeFile(join(linked, "dist", "index.html"), "<!doctype html>");
		await writeFile(join(linked, "real.txt"), "outside");
		await symlink(join(linked, "real.txt"), join(linked, "dist", "escape.css"));
		const linkDestination = await fixtureRoot("package-link");
		const linkOutcome = await prepare([linkDestination, "--ui-dist", join(linked, "dist")]);
		assert.notEqual(linkOutcome.code, 0);
		assert.match(linkOutcome.stderr, /symlink/);

		const clean = await buildDistFixture(false);
		const revisionDestination = await fixtureRoot("package-revision");
		const mismatch = await prepare([
			revisionDestination,
			"--ui-dist",
			clean,
			"--revision",
			"0".repeat(40),
		]);
		assert.notEqual(mismatch.code, 0);
		assert.match(mismatch.stderr, /does not match git HEAD/);
		const matched = await prepare([
			revisionDestination,
			"--ui-dist",
			clean,
			"--revision",
			await new Promise((resolvePromise, rejectPromise) =>
				execFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot }, (error, stdout) =>
					error ? rejectPromise(error) : resolvePromise(stdout.trim()),
				),
			),
		]);
		assert.equal(matched.code, 0, matched.stderr);

		const busy = await fixtureRoot("package-busy");
		await writeFile(join(busy, "stale.txt"), "keep out");
		const refused = await prepare([busy, "--ui-dist", clean]);
		assert.notEqual(refused.code, 0);
		assert.match(refused.stderr, /not empty/);
	});
});
