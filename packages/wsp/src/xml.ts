/**
 * Minimal XML parser sufficient for FlowJo .wsp and Gating-ML: elements, attributes (with namespace
 * prefixes kept verbatim), text, CDATA, comments, processing instructions, standard + numeric entities.
 * No DTD processing. Works in browser and Node without dependencies.
 */

export interface XmlElement {
	name: string;
	attrs: Record<string, string>;
	children: XmlElement[];
	text: string;
	parent: XmlElement | null;
}

export class XmlError extends Error {
	override name = "XmlError";
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
	if (!s.includes("&")) return s;
	return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
		if (e[0] === "#") {
			const code = e[1] === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : m;
		}
		return ENTITIES[e] ?? m;
	});
}

const NAME_END = /[\s/>=]/;

export function parseXml(src: string): XmlElement {
	const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "", parent: null };
	let cur = root;
	let i = 0;
	const n = src.length;

	const fail = (msg: string): never => {
		const line = src.slice(0, i).split("\n").length;
		throw new XmlError(`${msg} at line ${line}`);
	};

	while (i < n) {
		const lt = src.indexOf("<", i);
		if (lt < 0) {
			cur.text += decodeEntities(src.slice(i));
			break;
		}
		if (lt > i) cur.text += decodeEntities(src.slice(i, lt));
		i = lt + 1;

		if (src.startsWith("!--", i)) {
			const e = src.indexOf("-->", i + 3);
			if (e < 0) fail("unterminated comment");
			i = e + 3;
		} else if (src.startsWith("![CDATA[", i)) {
			const e = src.indexOf("]]>", i + 8);
			if (e < 0) fail("unterminated CDATA");
			cur.text += src.slice(i + 8, e);
			i = e + 3;
		} else if (src[i] === "?" || src[i] === "!") {
			// PI or DOCTYPE: skip to matching '>' (DOCTYPE internal subsets unsupported)
			const e = src.indexOf(">", i);
			if (e < 0) fail("unterminated declaration");
			i = e + 1;
		} else if (src[i] === "/") {
			const e = src.indexOf(">", i);
			if (e < 0) fail("unterminated end tag");
			const name = src.slice(i + 1, e).trim();
			if (cur.name !== name) fail(`mismatched end tag </${name}> for <${cur.name}>`);
			cur = cur.parent ?? fail("stray end tag");
			i = e + 1;
		} else {
			// start tag
			let j = i;
			while (j < n && !NAME_END.test(src[j] as string)) j++;
			const name = src.slice(i, j);
			if (!name) fail("empty tag name");
			const el: XmlElement = { name, attrs: {}, children: [], text: "", parent: cur };
			i = j;
			let selfClose = false;
			for (;;) {
				while (i < n && /\s/.test(src[i] as string)) i++;
				if (i >= n) fail("unterminated start tag");
				const c = src[i] as string;
				if (c === ">") {
					i++;
					break;
				}
				if (c === "/") {
					if (src[i + 1] !== ">") fail("bad self-closing tag");
					selfClose = true;
					i += 2;
					break;
				}
				let k = i;
				while (k < n && !NAME_END.test(src[k] as string)) k++;
				const an = src.slice(i, k);
				i = k;
				while (i < n && /\s/.test(src[i] as string)) i++;
				if (src[i] !== "=") fail(`attribute ${an} without value`);
				i++;
				while (i < n && /\s/.test(src[i] as string)) i++;
				const q = src[i] as string;
				if (q !== '"' && q !== "'") fail(`unquoted attribute ${an}`);
				const e = src.indexOf(q, i + 1);
				if (e < 0) fail("unterminated attribute value");
				el.attrs[an] = decodeEntities(src.slice(i + 1, e));
				i = e + 1;
			}
			cur.children.push(el);
			if (!selfClose) cur = el;
		}
	}
	if (cur !== root) fail(`unclosed element <${cur.name}>`);
	return root;
}

/** Strip a namespace prefix: "gating:PolygonGate" → "PolygonGate". */
export const localName = (name: string): string => {
	const c = name.indexOf(":");
	return c < 0 ? name : name.slice(c + 1);
};

export function child(el: XmlElement, local: string): XmlElement | undefined {
	return el.children.find((c) => localName(c.name) === local);
}

export function childrenOf(el: XmlElement, local: string): XmlElement[] {
	return el.children.filter((c) => localName(c.name) === local);
}

/** Attribute lookup ignoring namespace prefix. */
export function attr(el: XmlElement, local: string): string | undefined {
	const direct = el.attrs[local];
	if (direct !== undefined) return direct;
	for (const [k, v] of Object.entries(el.attrs)) if (localName(k) === local) return v;
	return undefined;
}

/** Depth-first search for all descendants with a local name. */
export function descendants(el: XmlElement, local: string, out: XmlElement[] = []): XmlElement[] {
	for (const c of el.children) {
		if (localName(c.name) === local) out.push(c);
		descendants(c, local, out);
	}
	return out;
}
