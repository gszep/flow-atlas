import { type ReferenceCoverageSample, referenceCoverage } from "./reference-coverage.ts";

export interface QuestionSample extends ReferenceCoverageSample {
	name: string;
}
export interface MeasuredAnswer {
	reference?: string;
	answer: string;
	basis: string;
	rows: { sampleIndex: number; sample: string; events: number; count: number | null }[];
}

/** Read already-computed workspace metadata. Never approximate a gate, alias or event mask. */
export function workspaceQuestion(
	text: string,
	samples: readonly QuestionSample[],
	references: readonly string[],
	active: number | null,
): MeasuredAnswer | null {
	const q = text
		.trim()
		.replace(/[?？.!。]+$/u, "")
		.trim();
	const bySample =
		/^(?:how many events (?:are there |are )?in each sample|count events by sample|各サンプルのイベント数)$/iu.test(
			q,
		);
	const scoped =
		/^(?:how many events (?:are there|are in (?:this|the selected) sample|are there in (?:this|the selected) sample)|count events|このサンプルのイベント数)$/iu.test(
			q,
		);
	const ref = /^(count reference|compare reference)\s+(.+?)$/iu.exec(q);
	const compare = ref?.[1]?.toLowerCase() === "compare reference";
	if (!scoped && !bySample && !ref) return null;
	const all = bySample || compare || active === null;
	if (active === null && scoped && /(?:this|selected) sample|このサンプル/iu.test(q))
		return {
			answer:
				"No single sample is selected. The view contains all samples; choose a sample or ask for counts in each sample.",
			basis: "Workspace sample selection; no count inferred.",
			rows: [],
		};
	if (!all && (!Number.isInteger(active) || !samples[active]))
		return {
			answer: "The selected sample is unavailable. No count was computed.",
			basis: "Workspace sample index",
			rows: [],
		};
	let reference: string | undefined;
	if (ref) {
		const requested = ref[2]?.trim() ?? "";
		const matches = references.filter((name) => name.toLowerCase() === requested.toLowerCase());
		if (matches.length !== 1)
			return {
				answer: `No unique reference named “${requested}”. Use its full workspace name; no count was inferred.`,
				basis: "Imported reference names",
				rows: [],
			};
		reference = matches[0];
	}
	const rows = samples.flatMap((sample, index) =>
		all || active === index
			? [
					{
						sampleIndex: index,
						sample: sample.name,
						events: sample.count,
						count:
							reference === undefined
								? sample.count
								: referenceCoverage(samples, reference, [index]),
					},
				]
			: [],
	);
	const denominator = rows.reduce((sum, row) => sum + row.events, 0);
	const missing = rows.filter((row) => row.count === null).length;
	const scope = all ? `all ${rows.length} workspace samples` : `sample “${rows[0]?.sample}”`;
	const n = (num: number) => num.toLocaleString();
	return {
		...(reference === undefined ? {} : { reference }),
		answer:
			reference !== undefined
				? missing
					? `The total for “${reference}” in ${scope} is unknown. ${missing} sample(s) have incomplete or ambiguous gate coverage.`
					: `“${reference}”: ${n(rows.reduce((sum, row) => sum + (row.count ?? 0), 0))} of ${n(denominator)} events in ${scope}.`
				: `${n(denominator)} events in ${scope}.`,
		basis:
			reference === undefined
				? "Loaded workspace event counts, before display filters."
				: "Evaluated imported leaf gate; denominator is all loaded events in the sample, not the parent gate. An imported name is not a validated identity.",
		rows,
	};
}
