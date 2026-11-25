import { describe, expect, it } from "vitest";
import { sampleVisible } from "../src/sample-filter.js";

describe("sample display filtering", () => {
	it("shows every sample by default, including ungrouped samples", () => {
		expect(
			sampleVisible(0, null, [], ["tissue"], ["batch 1"], new Set(["tissue", "batch 1"])),
		).toBe(true);
	});
	it("selects exactly one sample without changing group filters", () => {
		const selected = new Set(["tissue", "batch 1"]);
		expect(sampleVisible(1, 1, [], ["tissue"], ["batch 1"], selected)).toBe(true);
		expect(sampleVisible(0, 1, [], ["tissue"], ["batch 1"], selected)).toBe(false);
	});
	it("intersects an individual sample with the existing group filters", () => {
		const selected = new Set(["blood", "batch 1"]);
		expect(
			sampleVisible(0, 0, ["blood", "batch 1"], ["blood", "tissue"], ["batch 1"], selected),
		).toBe(true);
		expect(
			sampleVisible(1, 1, ["tissue", "batch 1"], ["blood", "tissue"], ["batch 1"], selected),
		).toBe(false);
	});
});
