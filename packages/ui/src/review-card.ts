import { type Inspection, reviewedExample } from "./inspection-review.js";

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
	const node = document.createElement(tag);
	node.textContent = text;
	return node;
};

export function reviewCard(
	turn: Inspection,
	followUp: (question: string) => void,
	dictate: (field: HTMLTextAreaElement) => void,
	speechEnabled: boolean,
) {
	const card = element("article");
	card.className = "inspection";
	card.append(
		element("h3", turn.question),
		element("small", `Asked in: ${turn.requestedView.name}`),
		element("p", turn.answer),
	);
	const evidence = element("details");
	evidence.append(
		element("summary", turn.local ? "Workspace evidence" : "Evidence for this response"),
	);
	if (turn.local) {
		evidence.append(element("p", turn.local.basis));
		if (turn.local.rows.length) {
			const table = element("table"),
				head = table.createTHead().insertRow();
			for (const label of ["Sample", "Count", "All events"]) head.append(element("th", label));
			const body = table.createTBody();
			for (const row of turn.local.rows) {
				const tr = body.insertRow();
				for (const value of [
					row.sample,
					row.count?.toLocaleString() ?? "Unknown",
					row.events.toLocaleString(),
				])
					tr.insertCell().textContent = value;
			}
			evidence.append(table);
		}
	} else {
		evidence.append(
			element(
				"p",
				`${turn.model ?? "Agent"} interpretation. Tool output is evidence of an operation, not proof of the interpretation.`,
			),
		);
		if (!turn.toolTrace.length)
			evidence.append(element("p", "No browser tool was called in this turn."));
		for (const entry of turn.toolTrace) {
			const line = element("div", `${entry.tool} · ${entry.summary}`);
			if (entry.preview) {
				const d = element("details");
				d.append(
					element("summary", entry.type === "tool-call" ? "Arguments preview" : "Output preview"),
					element("pre", entry.preview),
				);
				line.append(d);
			}
			evidence.append(line);
		}
	}
	const review = element("details"),
		note = element("textarea"),
		feedback = element("p");
	review.append(element("summary", "Check or correct this answer"));
	note.rows = 2;
	note.maxLength = 2000;
	note.placeholder = "What should the answer have said?";
	note.setAttribute("aria-label", "Review note");
	const actions = element("div");
	actions.className = "demo-toolbar";
	const rowSelect = element("select"),
		expected = element("input");
	const target = element("details");
	target.append(element("summary", "Optional: make a count correction testable"));
	if (turn.replay && turn.local?.rows.length) {
		rowSelect.setAttribute("aria-label", "Sample to check");
		for (const row of turn.local.rows) {
			const option = element("option", row.sample);
			option.value = String(row.sampleIndex);
			rowSelect.append(option);
		}
		expected.placeholder = "Expected count or unknown";
		expected.setAttribute("aria-label", "Expected count or unknown");
		target.append(rowSelect, expected);
	}
	const button = (label: string, fn: () => void) => {
		const b = element("button", label);
		b.type = "button";
		b.onclick = fn;
		actions.append(b);
		return b;
	};
	const save = (judgment: "matches-evidence" | "needs-correction") => {
		try {
			const raw = expected.value.trim().toLowerCase();
			if (raw && judgment === "matches-evidence")
				throw new Error("Use Download correction to save a different expected count.");
			if (raw && raw !== "unknown" && !/^\d+$/.test(raw))
				throw new Error("Enter a whole event count or unknown.");
			const record = reviewedExample(
				turn,
				judgment,
				note.value,
				raw
					? { sampleIndex: Number(rowSelect.value), count: raw === "unknown" ? null : Number(raw) }
					: undefined,
			);
			const url = URL.createObjectURL(
				new Blob([JSON.stringify(record, null, 2)], { type: "application/json" }),
			);
			const a = element("a");
			a.href = url;
			a.download = "flowatlas-inspection-review.json";
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
			feedback.textContent =
				"Review file prepared on this device. No annotation or model was changed.";
		} catch (error) {
			feedback.textContent = error instanceof Error ? error.message : "Review could not be saved.";
		}
	};
	if (speechEnabled) button("Dictate / stop note", () => dictate(note));
	button("Download as checked", () => save("matches-evidence"));
	button("Download correction", () => save("needs-correction"));
	button("Use note in follow-up", () => {
		if (!note.value.trim()) {
			feedback.textContent = "Add a note first.";
			return;
		}
		followUp(
			`Revisit this question: ${turn.question}\nOriginal sample view: ${turn.requestedView.name}\nMy correction: ${note.value.trim()}`,
		);
	});
	feedback.setAttribute("role", "status");
	review.append(
		element(
			"p",
			"Save the question, evidence and your judgment on this device. A checked table uses every displayed count as an expectation. Follow-ups are sent only when you ask.",
		),
		note,
	);
	if (turn.replay && turn.local?.rows.length) review.append(target);
	review.append(actions, feedback);
	card.append(evidence, review);
	return card;
}
