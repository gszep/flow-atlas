import { describe, expect, it } from "vitest";
import {
	type ComputationRecord,
	clearComputationRecord,
	embeddingSettings,
	publishComputationRecord,
} from "../src/computation.js";
import { DEMO_EMBED_OPTIONS } from "../src/demo.js";
import {
	PUBLICATION_EMBED_OPTIONS,
	publicationProfileLabel,
	publicationTrainingMode,
	publicationTrainingOptions,
} from "../src/publication.js";

function record(): ComputationRecord {
	return {
		schemaVersion: 1,
		completedAt: "2026-10-25T00:00:00Z",
		profile: "test",
		source: { kind: "publication", inputFileCount: 34, sampleCount: 33 },
		settings: embeddingSettings(publicationTrainingOptions(3885530, "all"), 3885530),
		projectedEventCount: 3885530,
		renderedEventCount: 3885530,
		featureCount: 2,
		features: ["A", "B"],
		renderScope: "Renderer inputs, not visible pixel count",
		gpu: {
			adapterDescription: null,
			effectiveStorageWindowBytes: 128 * 2 ** 20,
			deviceMaxStorageBindingBytes: 256 * 2 ** 20,
			deviceMaxBufferBytes: 512 * 2 ** 20,
		},
		wallMs: {
			input: 1,
			parseTransformsGating: 2,
			featurePreparation: 3,
			somTraining: 4,
			mapEmbedProjection: 5,
			displayPreparation: 6,
			total: 22,
		},
		timingScope: "Wall time, not GPU timestamps",
		gpuTimestampMeasurement: false,
		resources: {
			gpuMemoryBytes: null,
			gpuUtilizationPercent: null,
			browserMemoryBytes: null,
			cpuUtilizationPercent: null,
			scope: "not measured",
		},
	};
}
describe("client computation settings and wall-time records (CPU only)", () => {
	it("changes only trainMax for all-event publication training and selects stride one", () => {
		const limited = publicationTrainingOptions(3885530, "limited"),
			all = publicationTrainingOptions(3885530, "all");
		expect(limited).toEqual(PUBLICATION_EMBED_OPTIONS);
		expect(all).toEqual({ ...limited, trainMax: 3885530 });
		expect(embeddingSettings(all, 3885530).training).toMatchObject({
			mode: "all-events",
			stride: 1,
			trainMax: 3885530,
		});
		expect(embeddingSettings(limited, 3885530).training).toMatchObject({
			mode: "bounded",
			stride: 39,
			actualSelectedCount: null,
		});
		expect(publicationProfileLabel(3885530, "limited")).toContain("up to 100,000");
		expect(publicationProfileLabel(3885530, "all")).toContain("stride 1");
		expect(publicationProfileLabel(3885530, "all")).toContain("per SOM training epoch");
		for (const options of [limited, all]) {
			expect(embeddingSettings(options, 3885530)).toMatchObject({
				initializationStats: "strided",
				initializationStatsStride: 19,
				initializationStatsRows: 204501,
				training: { scope: "per-SOM-training-epoch" },
			});
		}
	});
	it("keeps default/local and synthetic settings unchanged and handles the all-events deep link", () => {
		expect(publicationTrainingMode("?publication&training=all")).toBe("all");
		expect(publicationTrainingMode("?publication")).toBe("limited");
		expect(publicationTrainingMode("?publication&training=invalid")).toBe("limited");
		expect(embeddingSettings({}, 3885530)).toMatchObject({
			grid: { x: 20, y: 20 },
			epochs: 20,
			training: { trainMax: 500000 },
			seeds: { imputation: 1, initialization: 42, training: 42 },
		});
		expect(embeddingSettings(DEMO_EMBED_OPTIONS, 3072)).toMatchObject({
			grid: { x: 8, y: 8 },
			epochs: 5,
			training: { trainMax: 4096 },
			seeds: { imputation: 20261025, initialization: 20261025, training: 20261025 },
		});
		expect(() => publicationTrainingOptions(0, "all")).toThrow(/event count/);
	});
	it("publishes metadata-only JSON and clears stale data on a new load or failure", () => {
		const node = { textContent: "stale" },
			panel = { hidden: false };
		clearComputationRecord(node, panel);
		expect(node.textContent).toBe("");
		expect(panel.hidden).toBe(true);
		const value = record();
		publishComputationRecord(value, node, panel);
		expect(JSON.parse(node.textContent)).toEqual(value);
		expect(panel.hidden).toBe(false);
		expect(JSON.parse(node.textContent).resources.gpuMemoryBytes).toBeNull();
		clearComputationRecord(node, panel);
		expect(node.textContent).toBe("");
		expect(panel.hidden).toBe(true);
	});
	it("rejects inconsistent timing/window/count records without leaving a stale success record", () => {
		const changes: Array<(value: ComputationRecord) => void> = [
			(value) => {
				value.wallMs.somTraining = NaN;
			},
			(value) => {
				value.wallMs.input = -1;
			},
			(value) => {
				value.wallMs.total = 1;
			},
			(value) => {
				value.renderedEventCount--;
			},
			(value) => {
				value.featureCount++;
			},
			(value) => {
				value.gpu.effectiveStorageWindowBytes = 256 * 2 ** 20;
			},
		];
		for (const change of changes) {
			const node = { textContent: "old-success" },
				panel = { hidden: false },
				value = record();
			change(value);
			expect(() => publishComputationRecord(value, node, panel)).toThrow(/Inconsistent/);
			expect(node.textContent).toBe("");
			expect(panel.hidden).toBe(true);
		}
	});
});
