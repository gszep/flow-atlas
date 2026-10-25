import { expect, it } from "vitest";
import { projectionChunks } from "../src/projection.js";

it("covers the full companion including the tail, without overlap or oversized batches", () => {
	const chunks = projectionChunks(3885530, 20, 128 * 2 ** 20);
	let next = 0;
	const valid = chunks.every((chunk) => {
		const ok =
			chunk.start === next &&
			chunk.count > 0 &&
			chunk.count <= 65536 &&
			(chunk.start * 80) % 256 === 0;
		next += chunk.count;
		return ok;
	});
	expect(valid).toBe(true);
	expect(next).toBe(3885530);
	expect(chunks.at(-1)?.count).toBe(18906);
});

it("also respects a smaller binding limit", () => {
	const chunks = projectionChunks(1000, 20, 5120);
	expect(chunks.every((chunk) => chunk.count * 80 <= 5120)).toBe(true);
	expect(chunks.reduce((sum, chunk) => sum + chunk.count, 0)).toBe(1000);
	expect(() => projectionChunks(100, 20, 1)).toThrow();
});
