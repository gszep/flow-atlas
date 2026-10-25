import { expect, it } from "vitest";
import { createLoadGate, downloadPresentation } from "../src/loading.js";

it("distinguishes manifest, byte progress and unfinished integrity checks", () => {
	expect(
		downloadPresentation({
			phase: "manifest",
			downloadedBytes: 0,
			totalBytes: 0,
			verifiedFiles: 0,
			fileCount: 0,
		}).percent,
	).toBeNull();
	expect(
		downloadPresentation({
			phase: "files",
			downloadedBytes: 50,
			totalBytes: 100,
			verifiedFiles: 0,
			fileCount: 2,
		}).percent,
	).toBe(50);
	expect(
		downloadPresentation({
			phase: "files",
			downloadedBytes: 100,
			totalBytes: 100,
			verifiedFiles: 1,
			fileCount: 2,
		}).label,
	).toContain("Verifying");
});

it("prevents overlapping automatic loads while allowing retry after settlement", () => {
	const gate = createLoadGate();
	expect(gate.begin()).toBe(true);
	expect(gate.begin()).toBe(false);
	gate.finish();
	expect(gate.busy).toBe(false);
	expect(gate.begin()).toBe(true);
});
