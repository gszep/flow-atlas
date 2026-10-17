import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
	resolve: {
		alias: {
			"@flow-atlas/compute": fileURLToPath(new URL("../compute/src/index.ts", import.meta.url)),
		},
	},
	test: { name: "host", include: ["test/**/*.test.ts"] },
});
