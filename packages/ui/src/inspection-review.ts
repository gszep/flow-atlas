import type { AgentEvent } from "./demo-agent.js";
import type { MeasuredAnswer, QuestionSample } from "./workspace-questions.js";

export interface Inspection {
	question: string;
	datasetKey: string;
	requestedView: { sampleIndex: number | null; name: string };
	answer: string;
	local: MeasuredAnswer | null;
	model: string | null;
	replay?: { samples: QuestionSample[]; references: string[] };
	toolTrace: {
		tool: string;
		callId?: string;
		type: "tool-call" | "tool-result" | "error";
		summary: string;
		preview?: string;
	}[];
}

export function observeTurn(turn: Inspection, event: AgentEvent) {
	if (event.type === "text" && event.final)
		turn.answer += `${turn.answer ? "\n" : ""}${event.text}`;
	if (event.type === "tool-call" || event.type === "tool-result" || event.type === "error") {
		turn.toolTrace.push({
			tool: event.name ?? "agent",
			...(event.id ? { callId: event.id } : {}),
			type: event.type,
			summary: event.text,
			...(event.details ? { preview: event.details } : {}),
		});
	}
}

export function reviewedExample(
	turn: Inspection,
	judgment: "matches-evidence" | "needs-correction",
	note: string,
	expectedRow?: { sampleIndex: number; count: number | null },
) {
	if (!turn.answer.trim() || (judgment === "needs-correction" && !note.trim()))
		throw new Error("Describe the correction before saving.");
	const rows = turn.local?.rows ?? [];
	if (
		expectedRow &&
		(!rows.some((row) => row.sampleIndex === expectedRow.sampleIndex) ||
			(expectedRow.count !== null &&
				(!Number.isSafeInteger(expectedRow.count) || expectedRow.count < 0)))
	)
		throw new Error("Invalid expected sample count.");
	const assertions = !turn.replay
		? []
		: judgment === "matches-evidence"
			? rows.map(({ sampleIndex, count }) => ({ sampleIndex, count }))
			: expectedRow
				? [expectedRow]
				: [];
	return {
		schema: "flowatlas-inspection-review-v1",
		inspection: turn,
		review: {
			judgment,
			assertions,
			note: note.trim(),
			meaning: "Human assessment of this answer, not a phenotype annotation or validated gate.",
		},
	};
}
