import type { SelectionAnalysis } from "./selection-engine.js";

const NS = "http://www.w3.org/2000/svg";
const number = (value: number | null) =>
	value === null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 1 });

export function violinPlots(
	container: HTMLElement,
	analysis: SelectionAnalysis,
	color: string,
	originalNames?: string[][],
) {
	container.replaceChildren();
	for (const channel of analysis.channels) {
		const figure = document.createElement("figure"),
			title = document.createElement("figcaption");
		title.textContent = channel.name;
		const names = originalNames?.[channel.index];
		if (names?.length) {
			const original = document.createElement("small");
			original.textContent = names.join(" / ");
			original.className = "channel-original";
			title.append(original);
		}
		figure.append(title);
		const svg = document.createElementNS(NS, "svg");
		svg.setAttribute("viewBox", "0 0 110 155");
		svg.setAttribute("role", "img");
		svg.setAttribute(
			"aria-label",
			`${channel.name}: ${channel.finiteCount} finite values, approximate median ${number(channel.median)}`,
		);
		if (channel.finiteCount > 0) {
			const density = channel.bins.map(
				(value, i, bins) => (value * 2 + (bins[i - 1] ?? value) + (bins[i + 1] ?? value)) / 4,
			);
			const peak = Math.max(1, ...density),
				y = (i: number) => 125 - (i / Math.max(1, density.length - 1)) * 105;
			const points = density
				.map((v, i) => `${55 - (v / peak) * 30},${y(i)}`)
				.concat(density.map((v, i) => `${55 + (v / peak) * 30},${y(i)}`).reverse());
			const path = document.createElementNS(NS, "path");
			path.setAttribute("d", `M${points.join(" L")} Z`);
			path.setAttribute("fill", color);
			path.setAttribute("fill-opacity", ".7");
			svg.append(path);
			if (channel.median !== null && channel.min !== null && channel.max !== null) {
				const medianY =
					channel.max === channel.min
						? 72
						: 125 - ((channel.median - channel.min) / (channel.max - channel.min)) * 105;
				const line = document.createElementNS(NS, "line");
				for (const [key, value] of Object.entries({ x1: 30, x2: 80, y1: medianY, y2: medianY }))
					line.setAttribute(key, String(value));
				line.setAttribute("stroke", "white");
				svg.append(line);
			}
		}
		for (const [value, y] of [
			[channel.max, 12],
			[channel.min, 143],
		] as const) {
			const text = document.createElementNS(NS, "text");
			text.setAttribute("x", "55");
			text.setAttribute("y", String(y));
			text.setAttribute("text-anchor", "middle");
			text.setAttribute("fill", "currentColor");
			text.setAttribute("font-size", "10");
			text.textContent = number(value);
			svg.append(text);
		}
		const detail = document.createElement("small");
		detail.textContent = `Median ≈ ${number(channel.median)}${channel.missingCount ? ` · ${channel.missingCount.toLocaleString()} missing` : ""}`;
		figure.append(svg, detail);
		container.append(figure);
	}
}
