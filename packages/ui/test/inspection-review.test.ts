import { describe, expect, it } from "vitest";
import { replayReview } from "../scripts/replay-review.mjs";
import { type Inspection, observeTurn, reviewedExample } from "../src/inspection-review.js";
import { workspaceQuestion } from "../src/workspace-questions.js";

const refs = ["Rare"];
const samples = [
	{
		name: "A",
		count: 99999,
		skippedGateCount: 0,
		gateCounts: [{ name: "Rare", count: 1, isLeaf: true }],
	},
	{ name: "B", count: 5, skippedGateCount: 1, gateCounts: [] },
];
const question = "Compare reference Rare";
function inspection(): Inspection {
	const local = workspaceQuestion(question, samples, refs, 0);
	return {
		local,
		question,
		answer: local?.answer ?? "",
		datasetKey: "a".repeat(64),
		requestedView: { name: "A", sampleIndex: 0 },
		model: null,
		toolTrace: [],
		replay: { samples, references: refs },
	};
}
describe("question → evidence → human review → offline replay", () => {
	it("retains rare events, never substitutes zero for incomplete references, and distinguishes the overall comparison from the selected view", () => {
		const r = inspection();
		expect(r.answer).toContain("unknown");
		expect(r.local?.rows.map((x) => x.count)).toEqual([1, null]);
		expect(workspaceQuestion("Count reference Rare", samples, refs, 0)?.answer).toContain(
			"1 of 99,999",
		);
		expect(workspaceQuestion("Count reference Rare", samples, refs, 1)?.answer).toContain(
			"unknown",
		);
		expect(workspaceQuestion("Count reference R", samples, refs, 0)?.rows).toEqual([]);
		expect(workspaceQuestion("Count reference Rare", samples, ["Rare", "rare"], 0)?.rows).toEqual(
			[],
		);
		expect(
			workspaceQuestion("How many events are in this sample?", samples, refs, 0)?.rows,
		).toHaveLength(1);
		expect(
			workspaceQuestion("How many events are in each sample?", samples, refs, 0)?.rows,
		).toHaveLength(2);
		expect(workspaceQuestion("Identify a cell type", samples, refs, null)).toBeNull();
	});
	it("scores current metadata computation against explicit human expectations, not the answer string", () => {
		const r = inspection(),
			checked = reviewedExample(r, "matches-evidence", "");
		expect(replayReview(checked)).toMatchObject({ status: "pass", assertions: 2 });
		expect(
			replayReview(
				reviewedExample(r, "needs-correction", "Synthetic incorrect negative", {
					sampleIndex: 0,
					count: 0,
				}),
			),
		).toMatchObject({ status: "fail", mismatchedRows: [0] });
		expect(
			replayReview(
				reviewedExample(r, "needs-correction", "Missing annotation", {
					sampleIndex: 1,
					count: null,
				}),
			),
		).toMatchObject({ status: "pass" });
		expect(replayReview(reviewedExample(r, "needs-correction", "Check the gate"))).toMatchObject({
			status: "not-scorable",
		});
		expect(() => reviewedExample(r, "needs-correction", " ")).toThrow();
		expect(() =>
			replayReview({
				...checked,
				review: { ...checked.review, assertions: [{ sampleIndex: 33, count: 0 }] },
			}),
		).toThrow();
	});
	it("does not present tool narration as final or treat model prose as a measured score", () => {
		const r = inspection();
		delete r.replay;
		r.local = null;
		r.answer = "";
		r.model = "test";
		observeTurn(r, { type: "text", text: "I will inspect…", final: false });
		observeTurn(r, {
			type: "error",
			name: "inspect_population",
			id: "t1",
			text: "Unknown coverage",
		});
		observeTurn(r, { type: "text", text: "Coverage is unknown.", final: true });
		expect(r.answer).toBe("Coverage is unknown.");
		expect(r.toolTrace[0]?.callId).toBe("t1");
		expect(replayReview(reviewedExample(r, "matches-evidence", ""))).toMatchObject({
			status: "not-scorable",
		});
	});
	it("does not pass when the numerator stays one but the denominator or sample identity changes", () => {
		const checked = reviewedExample(inspection(), "matches-evidence", "Synthetic reviewed table");
		for (const change of [{ count: 10 }, { name: "different specimen" }]) {
			const candidate = structuredClone(checked);
			const row = candidate.inspection.replay?.samples[0];
			if (!row) throw new Error("missing sample");
			Object.assign(row, change);
			// The question spans all samples: no active-sample validation masks a row comparison bug.
			candidate.inspection.requestedView = { sampleIndex: null, name: "All samples" };
			expect(replayReview(candidate)).toMatchObject({ status: "fail", mismatchedRows: [0] });
		}
	});
});
