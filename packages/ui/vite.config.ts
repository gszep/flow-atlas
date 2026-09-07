import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const pkg = (name: string) => fileURLToPath(new URL(`../${name}/src/index.ts`, import.meta.url));

/** Dev-only: serve the FlowAtlas.jl oracle dataset at /oracle/ so `?oracle` auto-loads it. */
function oraclePlugin(): Plugin {
	const root =
		process.env.FLOW_ATLAS_ORACLE ?? join(homedir(), "Documents/repos/FlowAtlas.jl/data");
	const list = (): string[] => {
		const out: string[] = [];
		const walk = (d: string) => {
			for (const e of readdirSync(d)) {
				const p = join(d, e);
				if (statSync(p).isDirectory()) walk(p);
				else if (/\.(fcs|wsp)$/i.test(e)) out.push(relative(root, p));
			}
		};
		if (existsSync(root)) walk(root);
		return out.sort();
	};
	return {
		name: "flow-atlas-oracle",
		configureServer(server) {
			server.middlewares.use("/oracle", (req, res, next) => {
				const url = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
				if (url === "/index.json") {
					res.setHeader("content-type", "application/json");
					res.end(JSON.stringify(list()));
					return;
				}
				const p = join(root, url);
				if (!p.startsWith(root) || !existsSync(p) || statSync(p).isDirectory()) return next();
				res.setHeader("content-type", "application/octet-stream");
				res.setHeader("content-length", String(statSync(p).size));
				import("node:fs").then((fs) => fs.createReadStream(p).pipe(res));
			});
		},
	};
}

export default defineConfig({
	server: { port: 3141 },
	preview: { port: 3141 },
	build: { target: "esnext" },
	plugins: [oraclePlugin()],
	resolve: {
		alias: {
			"@flow-atlas/compute": pkg("compute"),
			"@flow-atlas/fcs": pkg("fcs"),
			"@flow-atlas/transforms": pkg("transforms"),
			"@flow-atlas/wsp": pkg("wsp"),
		},
	},
});
