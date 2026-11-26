/** Local, offline replay of explicitly reviewed metadata counts, never a model grader. */
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { workspaceQuestion } from "../src/workspace-questions.ts";

const count = (x) => Number.isSafeInteger(x) && x >= 0;
const text = (x) => typeof x === "string" && x.length > 0 && x.length <= 4096;
const valid = (condition) => {
	if (!condition) throw new Error("Malformed or unsupported review case");
};
export function replayReview(record) {
	valid(record?.schema === "flowatlas-inspection-review-v1");
	const { inspection: t, review: r } = record;
	valid(
		t &&
			text(t.question) &&
			/^[a-f0-9]{64}$/.test(t.datasetKey) &&
			r &&
			["matches-evidence", "needs-correction"].includes(r.judgment) &&
			Array.isArray(r.assertions),
	);
	if (!t.replay || !r.assertions.length)
		return { status: "not-scorable", reason: "No explicit replayable count assertion" };
	const { samples, references } = t.replay;
	valid(
		Array.isArray(samples) &&
			samples.length > 0 &&
			samples.length <= 1024 &&
			Array.isArray(references) &&
			references.every(text),
	);
	for (const s of samples)
		valid(
			s &&
				text(s.name) &&
				count(s.count) &&
				(s.skippedGateCount === null || count(s.skippedGateCount)) &&
				Array.isArray(s.gateCounts) &&
				s.gateCounts.every(
					(g) =>
						g &&
						text(g.name) &&
						typeof g.isLeaf === "boolean" &&
						(g.count === null || (count(g.count) && g.count <= s.count)),
				),
		);
	const active = t.requestedView?.sampleIndex;
	valid(
		active === null ||
			(count(active) && active < samples.length && samples[active].name === t.requestedView.name),
	);
	valid(
		r.assertions.length <= samples.length &&
			new Set(r.assertions.map((a) => a?.sampleIndex)).size === r.assertions.length,
	);
	for (const a of r.assertions)
		valid(
			a &&
				count(a.sampleIndex) &&
				a.sampleIndex < samples.length &&
				(a.count === null || count(a.count)),
		);
	const candidate = workspaceQuestion(t.question, samples, references, active);
	const failures = r.assertions.filter(
		(a) =>
			!candidate?.rows.some((row) => row.sampleIndex === a.sampleIndex && row.count === a.count),
	);
	// A checked response covers every row; a correction checks only the named row(s).
	const scopeMismatch =
		r.judgment === "matches-evidence" && candidate?.rows.length !== r.assertions.length;
	return {
		status: failures.length || scopeMismatch ? "fail" : "pass",
		assertions: r.assertions.length,
		mismatchedRows: failures.map((a) => a.sampleIndex),
		scopeMismatch,
	};
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	try {
		if (process.argv.length !== 3)
			throw new Error("Usage: node packages/ui/scripts/replay-review.mjs REVIEW.json");
		const file = await open(process.argv[2], "r");
		let result;
		try {
			const st = await file.stat();
			valid(st.isFile() && st.size <= 2 * 1024 * 1024);
			result = replayReview(JSON.parse(await file.readFile("utf8")));
		} finally {
			await file.close();
		}
		console.log(JSON.stringify(result));
		process.exitCode = result.status === "pass" ? 0 : result.status === "fail" ? 1 : 2;
	} catch {
		console.error(
			"Review could not be replayed. Supply one valid local review JSON (up to 2 MiB).",
		);
		process.exitCode = 2;
	}
}
