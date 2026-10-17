import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const workspace = resolve(import.meta.dirname, "../..");
const inputHash = createHash("sha256");
async function hashTree(path) {
	for (const entry of (await readdir(resolve(workspace, path), { withFileTypes: true })).sort(
		(a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
	)) {
		const child = `${path}/${entry.name}`;
		if (entry.isDirectory()) await hashTree(child);
		else if (entry.isFile()) {
			inputHash.update(`${child}\0`);
			inputHash.update(
				createHash("sha256")
					.update(await readFile(resolve(workspace, child)))
					.digest("hex"),
			);
		}
	}
}
for (const name of ["compute", "fcs", "host", "model", "transforms", "wsp"])
	await hashTree(`packages/${name}/src`);
for (const path of ["packages/host/build.mjs", "packages/host/package.json", "pnpm-lock.yaml"]) {
	inputHash.update(`${path}\0`);
	inputHash.update(
		createHash("sha256")
			.update(await readFile(resolve(workspace, path)))
			.digest("hex"),
	);
}

// The same standalone WGSL assets serve browser/Vite and the native Node host.
// Bundle workspace code, leaving the MCP SDK and optional native Dawn addon external.
await build({
	absWorkingDir: import.meta.dirname,
	entryPoints: ["src/index.ts", "src/main.ts"],
	outdir: "dist",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	sourcemap: true,
	define: { __FLOW_ATLAS_BUILD_ID__: JSON.stringify(inputHash.digest("hex")) },
	external: ["@modelcontextprotocol/*", "zod", "zod/*", "webgpu"],
	plugins: [
		{
			name: "standalone-wgsl",
			setup(plugin) {
				plugin.onResolve(
					{ filter: /^@flow-atlas\/(compute|fcs|transforms|wsp|model)$/ },
					(args) => ({
						path: resolve(import.meta.dirname, "..", args.path.split("/")[1], "src/index.ts"),
					}),
				);
				plugin.onResolve({ filter: /\.wgsl\?raw$/ }, (args) => ({
					path: resolve(args.resolveDir, args.path.slice(0, -4)),
				}));
			},
		},
	],
	loader: { ".wgsl": "text" },
});
