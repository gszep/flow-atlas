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

export function parseXml(src: string, options: { strict?: boolean } = {}): XmlElement {
	const strict = options.strict === true;
	const validCharacter = (code: number) =>
		code === 9 ||
		code === 10 ||
		code === 13 ||
		(code >= 0x20 && code <= 0xd7ff) ||
		(code >= 0xe000 && code <= 0xfffd) ||
		(code >= 0x10000 && code <= 0x10ffff);
	if (strict) {
		if (new TextEncoder().encode(src).length > 8 * 2 ** 20) throw new XmlError("XML exceeds 8 MiB");
		for (const character of src)
			if (!validCharacter(character.codePointAt(0) as number))
				throw new XmlError("Invalid XML Unicode character");
	}
	const decode = (value: string): string => {
		if (!strict) return decodeEntities(value);
		return value.replace(/&([^;&]*);|&/g, (whole, entity: string | undefined) => {
			if (entity === undefined) throw new XmlError("Malformed XML entity");
			if (Object.hasOwn(ENTITIES, entity)) return ENTITIES[entity] as string;
			if (!/^#(?:x[0-9a-fA-F]+|[0-9]+)$/.test(entity))
				throw new XmlError(`Unsupported XML entity: ${whole}`);
			const code =
				entity[1] === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
			if (!Number.isSafeInteger(code) || !validCharacter(code))
				throw new XmlError("Invalid XML character reference");
			return String.fromCodePoint(code);
		});
	};
	const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "", parent: null };
	let depth = 0,
		elements = 0,
		attributes = 0;
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
			if (strict && src.slice(i).includes("]]>")) fail("CDATA terminator in text");
			cur.text += decode(src.slice(i));
			break;
		}
		if (lt > i) {
			if (strict && src.slice(i, lt).includes("]]>")) fail("CDATA terminator in text");
			cur.text += decode(src.slice(i, lt));
		}
		i = lt + 1;

		if (src.startsWith("!--", i)) {
			const e = src.indexOf("-->", i + 3);
			if (e < 0) fail("unterminated comment");
			if (strict && (src.slice(i + 3, e).includes("--") || src.slice(i + 3, e).endsWith("-")))
				fail("Invalid XML comment");
			i = e + 3;
		} else if (src.startsWith("![CDATA[", i)) {
			const e = src.indexOf("]]>", i + 8);
			if (e < 0) fail("unterminated CDATA");
			if (strict && cur === root) fail("CDATA outside root");
			cur.text += src.slice(i + 8, e);
			i = e + 3;
		} else if (src[i] === "?" || src[i] === "!") {
			if (strict) {
				if (src[i] === "!") fail("DTD and declarations are forbidden");
				const end = src.indexOf("?>", i);
				if (
					end < 0 ||
					root.children.length ||
					src.slice(0, lt).trim() ||
					!/^xml\s+version=(["'])1\.0\1(?:\s+encoding=(["'])UTF-8\2)?(?:\s+standalone=(["'])(?:yes|no)\3)?\s*$/i.test(
						src.slice(i + 1, end),
					)
				)
					fail("Unsupported or malformed processing instruction");
				i = end + 2;
				continue;
			}
			// PI or DOCTYPE: skip to matching '>' (DOCTYPE internal subsets unsupported)
			const e = src.indexOf(">", i);
			if (e < 0) fail("unterminated declaration");
			i = e + 1;
		} else if (src[i] === "/") {
			const e = src.indexOf(">", i);
			if (e < 0) fail("unterminated end tag");
			const name = src.slice(i + 1, e).trim();
			if (strict && !/^[A-Za-z_][\w.:-]*\s*$/.test(src.slice(i + 1, e)))
				fail("Invalid closing name");
			if (cur.name !== name) fail(`mismatched end tag </${name}> for <${cur.name}>`);
			cur = cur.parent ?? fail("stray end tag");
			depth--;
			i = e + 1;
		} else {
			// start tag
			let j = i;
			while (j < n && !NAME_END.test(src[j] as string)) j++;
			const name = src.slice(i, j);
			if (!name) fail("empty tag name");
			if (strict && !/^[A-Za-z_][\w.:-]*$/.test(name)) fail("Invalid XML name");
			if (strict && (++elements > 100000 || depth + 1 > 128))
				fail("XML element/depth budget exceeded");
			const el: XmlElement = {
				name,
				attrs: strict ? Object.create(null) : {},
				children: [],
				text: "",
				parent: cur,
			};
			const localAttributes = new Set<string>();
			i = j;
			let selfClose = false;
			for (;;) {
				const beforeWhitespace = i;
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
				if (strict && beforeWhitespace === i) fail("Attributes require whitespace separation");
				let k = i;
				while (k < n && !NAME_END.test(src[k] as string)) k++;
				const an = src.slice(i, k);
				if (strict) {
					const local = localName(an);
					if (
						!/^[A-Za-z_][\w.:-]*$/.test(an) ||
						["__proto__", "prototype", "constructor"].includes(local)
					)
						fail("Invalid or unsafe attribute name");
					if (localAttributes.has(local)) fail("Duplicate local attribute");
					localAttributes.add(local);
					if (localAttributes.size > 128 || ++attributes > 200000)
						fail("XML attribute budget exceeded");
				}
				i = k;
				while (i < n && /\s/.test(src[i] as string)) i++;
				if (src[i] !== "=") fail(`attribute ${an} without value`);
				i++;
				while (i < n && /\s/.test(src[i] as string)) i++;
				const q = src[i] as string;
				if (q !== '"' && q !== "'") fail(`unquoted attribute ${an}`);
				const e = src.indexOf(q, i + 1);
				if (e < 0) fail("unterminated attribute value");
				const value = src.slice(i + 1, e);
				if (strict && (value.includes("<") || value.length > 65536))
					fail("Invalid or oversized attribute value");
				// Normalize literal attribute whitespace before decoding references, so
				// &#10;/&#9;/&#13; retain their explicitly referenced characters.
				el.attrs[an] = decode(
					strict ? value.replace(/\r\n/g, "\n").replace(/[\t\n\r]/g, " ") : value,
				);
				i = e + 1;
			}
			if (strict && cur === root && root.children.length) fail("Multiple XML roots");
			cur.children.push(el);
			if (!selfClose) {
				cur = el;
				depth++;
			}
		}
	}
	if (cur !== root) fail(`unclosed element <${cur.name}>`);
	if (strict && (root.children.length !== 1 || root.text.trim()))
		fail("Missing root or text outside root");
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
