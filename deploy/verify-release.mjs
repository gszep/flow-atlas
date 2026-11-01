import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function bytes(url, limit) {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(30_000),
		headers: { "cache-control": "no-cache" },
	});
	if (!response.ok || !response.body) throw new Error(`Release request failed: ${response.status}`);
	let count = 0;
	const chunks = [];
	for await (const chunk of response.body) {
		count += chunk.length;
		if (count > limit) throw new Error("Release response exceeds its byte budget");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

export async function verifyRelease(baseURL, revision) {
	const base = new URL(baseURL);
	if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Expected a full source revision");
	const release = JSON.parse(await bytes(new URL("/release.json", base), 1024 * 1024));
	if (release.source?.gitSha !== revision || release.source.dirty)
		throw new Error("Served source revision does not match the deployment");
	const assets = release.assets.filter(
		(asset) => asset.path === "public/index.html" || asset.path.startsWith("public/assets/"),
	);
	if (!assets.some((asset) => asset.path === "public/index.html") || assets.length < 2)
		throw new Error("Release has no complete UI asset set");
	for (const asset of assets) {
		if (asset.path.includes("\\") || asset.path.split("/").some((part) => part === ".." || !part))
			throw new Error("Invalid release asset path");
		const content = await bytes(new URL(`/${asset.path.slice(7)}`, base), 16 * 1024 * 1024);
		if (
			content.length !== asset.bytes ||
			createHash("sha256").update(content).digest("hex") !== asset.sha256
		)
			throw new Error(`Served asset mismatch: ${asset.path}`);
	}
	const config = JSON.parse(await bytes(new URL("/api/demo/config", base), 64 * 1024));
	if (!config.agentConfigured || !config.speechConfigured)
		throw new Error("The deployed agent or speech configuration is missing");
	return { revision, verifiedAssets: assets.length, url: base.origin };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	console.log(JSON.stringify(await verifyRelease(process.argv[2], process.argv[3])));
}
