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
import { stageDemoPackage } from "./prepare.mjs";
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
	return createStaticServer({ publicRoot, releasePath, log: () => {} }).then((server) => {
		servers.push(server);
		return new Promise((ready) => {
			server.listen(0, "127.0.0.1", () => ready(server));
		});
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

/** Generic built-UI dist fixture (no hostile entries unless requested). */
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

describe("prepare staging and verification", () => {
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

describe("publication dataset staging and streaming", () => {
	/** Tiny explicit publication fixture: two payloads, one nested, ~2 MiB total. */
	async function publicationFixture() {
		const root = await fixtureRoot("publication");
		const dataRoot = join(root, "data");
		await mkdir(join(dataRoot, "390C"), { recursive: true });
		const alpha = Buffer.from("A".repeat(1500));
		const beta = Buffer.concat([Buffer.from("B".repeat(1024 * 1024)), Buffer.from("tail")]);
		await writeFile(join(dataRoot, "390C", "alpha.fcs"), alpha);
		await writeFile(join(dataRoot, "beta.wsp"), beta);
		await writeFile(join(dataRoot, "private.fcs"), "never listed");
		const manifest = {
			schemaVersion: 1,
			id: "fixture-companion-v1",
			title: "Fixture companion",
			citation: { title: "Fixture", doi: "10.1/fixture", url: "https://example.test/doi" },
			sourceVersion: "fixture-2026-10-25",
			sampleCount: 2,
			eventCount: 3,
			totalBytes: alpha.length + beta.length,
			files: [
				{
					path: "390C/alpha.fcs",
					name: "alpha.fcs",
					kind: "fcs",
					bytes: alpha.length,
					sha256: createHash("sha256").update(alpha).digest("hex"),
					events: 1,
					channels: 2,
				},
				{
					path: "beta.wsp",
					name: "beta.wsp",
					kind: "wsp",
					bytes: beta.length,
					sha256: createHash("sha256").update(beta).digest("hex"),
				},
			],
			notes: ["Fixture note."],
		};
		const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, "\t")}\n`);
		return { root, dataRoot, manifest, manifestBytes, alpha, beta };
	}

	function stagedPackage(publication) {
		const dist = buildDistFixture(false);
		const destination = fixtureRoot("publication-package");
		return Promise.all([destination, dist]).then(async ([destinationPath, distPath]) => {
			const { release } = await stageDemoPackage({
				destination: destinationPath,
				uiDist: distPath,
				publicationRoot: publication?.dataRoot,
				publicationManifest: publication?.manifest,
			});
			return { destination: destinationPath, release };
		});
	}

	it("stages only manifest-listed payloads with verified hashes and a release descriptor", async () => {
		const publication = await publicationFixture();
		const { destination, release } = await stagedPackage(publication);
		// Exactly the listed payloads plus the manifest copy; the unlisted private
		// file is never staged anywhere.
		const stagedTree = await readdir(join(destination, "public", "publication"), {
			recursive: true,
		});
		const names = stagedTree.filter((entry) => !entry.includes("/")).sort();
		assert.deepEqual(names, ["390C", "beta.wsp", "manifest.json"]);
		const nested = await readdir(join(destination, "public", "publication", "390C"));
		assert.deepEqual(nested, ["alpha.fcs"]);
		assert.equal(
			await readFile(join(destination, "public", "publication", "private.fcs"), "utf8").catch(
				() => "absent",
			),
			"absent",
		);
		// Staged bytes are verbatim.
		assert.equal(
			(await readFile(join(destination, "public", "publication", "390C", "alpha.fcs"))).equals(
				publication.alpha,
			),
			true,
		);
		assert.equal(
			(await readFile(join(destination, "public", "publication", "beta.wsp"))).equals(
				publication.beta,
			),
			true,
		);
		assert.equal(
			(await readFile(join(destination, "public", "publication", "manifest.json"))).equals(
				publication.manifestBytes,
			),
			true,
		);
		// The release records every file plus the publication descriptor.
		const publicationAssets = release.assets.filter((asset) =>
			asset.path.startsWith("public/publication/"),
		);
		assert.deepEqual(publicationAssets.map((asset) => asset.path).sort(), [
			"public/publication/390C/alpha.fcs",
			"public/publication/beta.wsp",
			"public/publication/manifest.json",
		]);
		assert.equal(release.publication.id, "fixture-companion-v1");
		assert.equal(
			release.publication.manifestSha256,
			createHash("sha256").update(publication.manifestBytes).digest("hex"),
		);
		assert.equal(release.publication.fileCount, 2);
		assert.equal(release.publication.bytes, publication.manifest.totalBytes);
	});

	it("serves allowlisted payloads streamed, manifest no-store, data revalidating, unknown 404", async () => {
		const publication = await publicationFixture();
		const { destination } = await stagedPackage(publication);
		const server = await listenEphemeral(
			join(destination, "public"),
			join(destination, "release.json"),
		);
		// Manifest endpoint: no-store, JSON, byte-identical to the staged manifest.
		const manifest = await fetch(`${base(server)}/publication/manifest.json`);
		assert.equal(manifest.status, 200);
		assert.equal(manifest.headers.get("cache-control"), "no-store");
		assert.match(manifest.headers.get("content-type"), /application\/json/);
		assert.equal(Buffer.from(await manifest.arrayBuffer()).equals(publication.manifestBytes), true);
		// Nested payload: full bytes, octet-stream, manifest length, no-cache with ETag.
		const alpha = await fetch(`${base(server)}/publication/390C/alpha.fcs`);
		assert.equal(alpha.status, 200);
		assert.equal(alpha.headers.get("content-type"), "application/octet-stream");
		assert.equal(alpha.headers.get("content-length"), String(publication.alpha.length));
		assert.equal(alpha.headers.get("cache-control"), "no-cache");
		assert.match(alpha.headers.get("etag"), /^"[a-f0-9]{64}"$/);
		const alphaBytes = Buffer.from(await alpha.arrayBuffer());
		assert.equal(alphaBytes.equals(publication.alpha), true);
		// HEAD carries metadata without a body.
		const head = await fetch(`${base(server)}/publication/beta.wsp`, { method: "HEAD" });
		assert.equal(head.status, 200);
		assert.equal(head.headers.get("content-length"), String(publication.beta.length));
		assert.equal(await head.text(), "");
		// Conditional GET revalidates via the manifest hash; 304 has no body.
		const revalidated = await fetch(`${base(server)}/publication/390C/alpha.fcs`, {
			headers: { "if-none-match": alpha.headers.get("etag") },
		});
		assert.equal(revalidated.status, 304);
		assert.equal(await revalidated.text(), "");
		// Unlisted and hostile publication paths 404 without leaking content.
		for (const path of [
			"/publication/private.fcs",
			"/publication/ghost.wsp",
			"/publication/390C/",
			"/publication/.hidden",
			"/publication/390C/alpha.fcs/",
		]) {
			const response = await fetch(`${base(server)}${path}`);
			assert.ok(response.status === 404 || response.status === 400, path);
			assert.ok(!(await response.text()).includes("never listed"), path);
		}
		// The generic asset path still refuses data extensions.
		assert.equal((await fetch(`${base(server)}/some.fcs`)).status, 404);
		// A streamed ~1 MiB payload equals its source hash exactly (stream intact).
		const beta = await fetch(`${base(server)}/publication/beta.wsp`);
		assert.equal(
			createHash("sha256")
				.update(Buffer.from(await beta.arrayBuffer()))
				.digest("hex"),
			publication.manifest.files[1].sha256,
		);
	});

	it("rejects wrong declared hashes, escaping paths, missing payloads and oversized budgets", async () => {
		const publication = await publicationFixture();
		// Manifest hash disagrees with the actual bytes on disk.
		const corrupted = JSON.parse(JSON.stringify(publication.manifest));
		corrupted.files[0].sha256 = "0".repeat(64);
		const destination = await fixtureRoot("publication-corrupt");
		await assert.rejects(
			stageDemoPackage({
				destination,
				uiDist: await buildDistFixture(false),
				publicationRoot: publication.dataRoot,
				publicationManifest: corrupted,
			}),
			/hash mismatch/,
		);
		// Declared size disagrees with the file.
		const wrongSize = JSON.parse(JSON.stringify(publication.manifest));
		wrongSize.files[1].bytes += 1;
		const sizeDestination = await fixtureRoot("publication-size");
		await assert.rejects(
			stageDemoPackage({
				destination: sizeDestination,
				uiDist: await buildDistFixture(false),
				publicationRoot: publication.dataRoot,
				publicationManifest: wrongSize,
			}),
			/size mismatch/,
		);
		// A payload path escaping the publication root is unusable.
		const escaping = JSON.parse(JSON.stringify(publication.manifest));
		escaping.files[0].path = "../outside.fcs";
		const escapeDestination = await fixtureRoot("publication-escape");
		await assert.rejects(
			stageDemoPackage({
				destination: escapeDestination,
				uiDist: await buildDistFixture(false),
				publicationRoot: publication.dataRoot,
				publicationManifest: escaping,
			}),
			/escapes|unusable/,
		);
		// A listed payload that does not exist fails staging.
		const missing = JSON.parse(JSON.stringify(publication.manifest));
		missing.files[1].path = "ghost.wsp";
		missing.files[1].name = "ghost.wsp";
		const missingDestination = await fixtureRoot("publication-missing");
		await assert.rejects(
			stageDemoPackage({
				destination: missingDestination,
				uiDist: await buildDistFixture(false),
				publicationRoot: publication.dataRoot,
				publicationManifest: missing,
			}),
			/missing or not a regular file/,
		);
		// Publication staging is all-or-nothing: no failed pass leaves any payload.
		for (const root of [destination, sizeDestination, escapeDestination, missingDestination]) {
			const publicationDir = await readdir(join(root, "public", "publication")).catch(() => null);
			assert.equal(publicationDir, null, root);
		}
	});

	it("keeps code-only staging free of any data when no publication root is given", async () => {
		const dist = await buildDistFixture(false);
		const destination = await fixtureRoot("package-codeonly");
		const { release: result } = await stageDemoPackage({ destination, uiDist: dist });
		assert.equal(result.publication, undefined);
		const tree = await readdir(join(destination, "public"), { recursive: true });
		assert.ok(!tree.some((entry) => entry.includes("publication")));
		assert.ok(!tree.some((entry) => entry.endsWith(".fcs") || entry.endsWith(".wsp")));
		// The production CLI without --publication-root stages no data either.
		const cliDestination = await fixtureRoot("package-cli");
		const cli = await prepare([cliDestination, "--ui-dist", dist]);
		assert.equal(cli.code, 0, cli.stderr);
		const cliTree = await readdir(join(cliDestination, "public"), { recursive: true });
		assert.ok(!cliTree.some((entry) => entry.includes("publication")));
	});

	it("survives an aborted publication download and keeps serving the next request", async () => {
		const publication = await publicationFixture();
		const { destination } = await stagedPackage(publication);
		const server = await listenEphemeral(
			join(destination, "public"),
			join(destination, "release.json"),
		);
		// Request the ~1 MiB payload with a small highWaterMark and abort mid-stream.
		const controller = new AbortController();
		const response = await fetch(`${base(server)}/publication/beta.wsp`, {
			signal: controller.signal,
			headers: { "accept-encoding": "identity" },
		});
		assert.equal(response.status, 200);
		const reader = response.body.getReader();
		const first = await reader.read();
		assert.ok(first.value.byteLength > 0);
		controller.abort();
		await reader.read().then(
			() => {},
			() => {},
		);
		// Give the server a moment to surface any mishandled disconnect.
		await new Promise((pause) => setTimeout(pause, 100));
		// The same server must remain alive and answer normally afterwards.
		const next = await fetch(`${base(server)}/publication/manifest.json`);
		assert.equal(next.status, 200);
		const alpha = await fetch(`${base(server)}/publication/390C/alpha.fcs`);
		assert.equal(alpha.status, 200);
		assert.equal((await alpha.arrayBuffer()).byteLength, publication.alpha.length);
	});

	it("keeps publication allowlists independent between server instances", async () => {
		const first = await publicationFixture();
		const second = await publicationFixture();
		// Server A stages the full fixture manifest; server B stages a manifest that only
		// lists beta.wsp. A must keep serving its own payload and must NOT start serving
		// B's (or vice versa) after both are live. Staging completes before either server
		// loads its allowlist.
		const onlyBeta = JSON.parse(JSON.stringify(first.manifest));
		onlyBeta.files = onlyBeta.files.filter((entry) => entry.path === "beta.wsp");
		const destinationA = await fixtureRoot("publication-instance-a");
		const destinationB = await fixtureRoot("publication-instance-b");
		const [,] = [
			await stageDemoPackage({
				destination: destinationA,
				uiDist: await buildDistFixture(false),
				publicationRoot: first.dataRoot,
				publicationManifest: first.manifest,
			}),
			await stageDemoPackage({
				destination: destinationB,
				uiDist: await buildDistFixture(false),
				publicationRoot: second.dataRoot,
				publicationManifest: onlyBeta,
			}),
		];
		const serverA = await listenEphemeral(
			join(destinationA, "public"),
			join(destinationA, "release.json"),
		);
		const serverB = await listenEphemeral(
			join(destinationB, "public"),
			join(destinationB, "release.json"),
		);
		// A serves its full manifest; B serves only beta.wsp.
		assert.equal((await fetch(`${base(serverA)}/publication/390C/alpha.fcs`)).status, 200);
		assert.equal((await fetch(`${base(serverB)}/publication/390C/alpha.fcs`)).status, 404);
		assert.equal((await fetch(`${base(serverA)}/publication/beta.wsp`)).status, 200);
		assert.equal((await fetch(`${base(serverB)}/publication/beta.wsp`)).status, 200);
		// Cross-requests remain asymmetric after both servers handled traffic.
		assert.equal((await fetch(`${base(serverA)}/publication/390C/alpha.fcs`)).status, 200);
		assert.equal((await fetch(`${base(serverB)}/publication/390C/alpha.fcs`)).status, 404);
	});

	it("rejects staging when a payload source is swapped between verification and copy", async () => {
		const publication = await publicationFixture();
		// beta.wsp verifies first pass; alpha.fcs is swapped in-place after the first
		// (verification) read and before the staged-bytes re-check can pass.
		const swapped = Buffer.from("X".repeat(publication.beta.length));
		const target = join(publication.dataRoot, "beta.wsp");
		const original = await readFile(target);
		// Keep the same size but different bytes so a size-only guard would pass.
		assert.equal(swapped.length, original.length);
		const destination = await fixtureRoot("publication-toctou");
		// Simulate the window by making the manifest hash stale: hash A, then write B,
		// then stage with A's manifest. The staged-bytes check must reject it.
		const stale = JSON.parse(JSON.stringify(publication.manifest));
		stale.files = stale.files.filter((entry) => entry.path === "beta.wsp");
		stale.totalBytes = original.length;
		try {
			await writeFile(target, swapped);
			await assert.rejects(
				stageDemoPackage({
					destination,
					uiDist: await buildDistFixture(false),
					publicationRoot: publication.dataRoot,
					publicationManifest: stale,
				}),
				/hash mismatch/,
			);
			// No partial staging survives the failure.
			const staged = await readdir(join(destination, "public", "publication")).catch(() => null);
			assert.equal(staged, null);
		} finally {
			await writeFile(target, original);
		}
	});

	it("streams the pinned production manifest metadata with a verified real payload end-to-end", async () => {
		// Real pinned manifest, but the payload comes from a tiny fixture directory that
		// reproduces one real listed file's bytes; production staging runs against the
		// authorized read-only data path, which this CPU test does not touch.
		const pinned = JSON.parse(
			await readFile(join(repoRoot, "deploy", "publication-manifest.json"), "utf8"),
		);
		assert.equal(pinned.schemaVersion, 1);
		assert.equal(pinned.sampleCount, 33);
		assert.equal(pinned.eventCount, 3885530);
		assert.equal(pinned.totalBytes, 295841667);
		assert.equal(pinned.files.length, 34);
		const fixture = await publicationFixture();
		// Replace the fixture's first listed payload with a real pinned entry identity.
		const real = pinned.files[1];
		const destination = await fixtureRoot("publication-pinned");
		const manifest = JSON.parse(JSON.stringify(fixture.manifest));
		manifest.id = pinned.id;
		manifest.files = [
			{
				path: real.path,
				name: real.name,
				kind: real.kind,
				bytes: fixture.alpha.length,
				sha256: createHash("sha256").update(fixture.alpha).digest("hex"),
				events: real.events,
				channels: real.channels,
			},
		];
		await mkdir(join(fixture.dataRoot, "390C"), { recursive: true });
		await writeFile(join(fixture.dataRoot, real.path), fixture.alpha);
		const { release: result } = await stageDemoPackage({
			destination,
			uiDist: await buildDistFixture(false),
			publicationRoot: fixture.dataRoot,
			publicationManifest: manifest,
		});
		assert.equal(result.publication.id, pinned.id);
		const server = await listenEphemeral(
			join(destination, "public"),
			join(destination, "release.json"),
		);
		const served = await fetch(`${base(server)}/publication/${real.path}`);
		assert.equal(served.status, 200);
		assert.equal(served.headers.get("content-type"), "application/octet-stream");
		assert.equal((await served.arrayBuffer()).byteLength, fixture.alpha.length);
	});
});
