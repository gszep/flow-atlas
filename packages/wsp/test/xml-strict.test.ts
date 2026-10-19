import { describe, expect, it } from "vitest";
import { readWsp } from "../src/index.js";
import { parseXml } from "../src/xml.js";

describe("opt-in bounded strict XML", () => {
	it("normalizes literal attribute whitespace before entity decoding without changing legacy mode", () => {
		const literal = "X\nY\tZ\r\nQ\rR";
		const source = `<a literal="${literal}" referenced="X&#10;Y&#9;Z&#13;&#10;Q&#13;R" mixed="A\r\n&#10;\tB"/>`;
		const strict = parseXml(source, { strict: true }).children[0]?.attrs;
		expect(strict?.literal).toBe("X Y Z Q R");
		expect(strict?.referenced).toBe(literal);
		expect(strict?.mixed).toBe("A \n B");
		const legacy = parseXml(source).children[0]?.attrs;
		expect(legacy?.literal).toBe(literal);
		expect(legacy?.referenced).toBe(literal);
		expect(legacy?.mixed).toBe("A\r\n\n\tB");
	});
	it("retains existing default behavior while strict admission rejects lossy duplicates", () => {
		expect(parseXml('<a x="1" x="2"/>').children[0]?.attrs.x).toBe("2");
		expect(() => parseXml('<a x="1" x="2"/>', { strict: true })).toThrow(/Duplicate/);
		expect(parseXml("<a/><b/>").children).toHaveLength(2);
		expect(() => parseXml("<a/><b/>", { strict: true })).toThrow(/Multiple/);
	});
	it("supports declared XML 1.0 UTF-8, comments, CDATA and valid numeric entities", () => {
		const doc = parseXml(
			`<?xml version='1.0' encoding='UTF-8'?><!--note--><g:a xmlns:g="urn:test" x="a&amp;b"><![CDATA[<text>]]>&#65;&#x1F600;</g:a>`,
			{ strict: true },
		);
		expect(doc.children[0]?.attrs.x).toBe("a&b");
		expect(doc.children[0]?.text).toBe("<text>A😀");
		expect(Object.getPrototypeOf(doc.children[0]?.attrs)).toBeNull();
	});
	it("caps UTF-8 bytes independently of source string code units", () => {
		expect(() => parseXml(`<a>${"雪".repeat(3 * 2 ** 20)}</a>`, { strict: true })).toThrow(/8 MiB/);
	});
	it("rejects ampersand runs without quadratic entity matching", () => {
		expect(() => parseXml(`<a>${"&".repeat(100000)}</a>`, { strict: true })).toThrow(/entity/);
		expect(() => parseXml("<a><!--bad---></a>", { strict: true })).toThrow(/comment/);
	});
	it("does not inherit prototype properties as display transforms for channel names", () => {
		const workspace = readWsp(
			'<Workspace><SampleList><Sample><DataSet sampleID="1" uri="file:/x.fcs"/><Keywords><Keyword name="$PAR" value="1"/><Keyword name="$P1N" value="constructor"/><Keyword name="$P1B" value="32"/></Keywords></Sample></SampleList></Workspace>',
			{ strict: true },
		);
		expect(workspace.samples[0]?.transforms.constructor).toBeUndefined();
		expect(Object.getPrototypeOf(workspace.samples[0]?.transforms)).toBeNull();
	});
});
