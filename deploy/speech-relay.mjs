import WebSocket, { WebSocketServer } from "ws";

/** Same-origin, single-use ticket relay. Upstream credentials never reach the browser. */
export function attachSpeechRelay(
	server,
	demo,
	{
		env = process.env,
		connect = (url, options) => new WebSocket(url, options),
		maxStreamMs = 90_000,
	} = {},
) {
	const active = new Set();
	let closed = false;
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: 8192,
		perMessageDeflate: false,
		handleProtocols: (protocols) =>
			protocols.has("flow-atlas.dictation") ? "flow-atlas.dictation" : false,
	});
	const reject = (socket, code) =>
		socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	const upgrade = (request, socket, head) => {
		socket.on("error", () => socket.destroy());
		if (request.url !== "/api/demo/speech") {
			reject(socket, 404);
			return;
		}
		const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
			.split(",")
			.map((s) => s.trim());
		if (protocols.length !== 2 || protocols[0] !== "flow-atlas.dictation") {
			reject(socket, 401);
			return;
		}
		if (active.size >= 2) {
			reject(socket, 429);
			return;
		}
		const lease = demo.claimSpeechTicket(protocols[1], request.headers.origin, request);
		if (!lease) {
			reject(socket, 401);
			return;
		}
		wss.handleUpgrade(request, socket, head, (client) => {
			let upstream,
				ended = false,
				ready = false,
				bytes = 0,
				controls = 0,
				secondStart = Date.now(),
				secondBytes = 0;
			let deadline, opening;
			const finish = (reason = "Dictation ended", failed = false) => {
				if (ended) return;
				ended = true;
				clearTimeout(deadline);
				clearTimeout(opening);
				active.delete(finish);
				lease.release();
				if (client.readyState === WebSocket.OPEN) {
					if (failed) client.send(JSON.stringify({ type: "Error", message: reason }));
					client.close(failed ? 1011 : 1000, reason);
				}
				upstream?.terminate();
				if (client.readyState !== WebSocket.CLOSED) {
					const force = setTimeout(() => client.terminate(), 1000);
					force.unref();
					client.once("close", () => clearTimeout(force));
				}
			};
			active.add(finish);
			lease.bind(() => finish("Session closed"));
			client.on("error", () => finish("Audio connection failed", true));
			client.on("close", () => finish());
			deadline = setTimeout(
				() => finish("Dictation time limit reached"),
				Math.max(1, Math.min(90_000, maxStreamMs)),
			);
			deadline.unref();
			opening = setTimeout(() => finish("Dictation service did not connect", true), 10_000);
			opening.unref();
			try {
				const url = new URL("/v1/listen", env.FLOW_DEEPGRAM_WORKER_URL);
				url.protocol = "wss:";
				url.search = new URLSearchParams({
					encoding: "linear16",
					sample_rate: "16000",
					channels: "1",
					interim_results: "true",
					store: "false",
					mip_opt_out: "true",
				}).toString();
				upstream = connect(url, {
					headers: {
						Authorization: `Token ${String(env.FLOW_DEEPGRAM_WORKER_TOKEN ?? "").trim()}`,
					},
					handshakeTimeout: 8000,
					maxPayload: 128 * 1024,
					perMessageDeflate: false,
					followRedirects: false,
				});
			} catch {
				finish("Dictation service unavailable", true);
				return;
			}
			upstream.on("error", () => finish("Dictation service unavailable", true));
			upstream.on("unexpected-response", (_request, response) => {
				response.resume();
				finish("Dictation service rejected the connection", true);
			});
			upstream.on("open", () => {
				if (ended || !lease.active()) {
					finish("Session closed");
					return;
				}
				clearTimeout(opening);
				ready = true;
				client.send(JSON.stringify({ type: "Ready" }));
			});
			upstream.on("message", (data, binary) => {
				if (ended || !lease.active()) {
					finish("Session closed");
					return;
				}
				if (binary || data.byteLength > 128 * 1024 || client.bufferedAmount > 128 * 1024) {
					finish("Dictation response limit exceeded", true);
					return;
				}
				try {
					const message = JSON.parse(data.toString());
					if (message.type === "Error") {
						finish("Transcription service returned an error", true);
						return;
					}
					if (["Results", "Metadata", "UtteranceEnd", "SpeechStarted"].includes(message.type))
						client.send(JSON.stringify(message));
				} catch {
					finish("Invalid transcription response", true);
				}
			});
			upstream.on("close", (code) =>
				finish(
					code === 1000 ? "Dictation complete" : "Dictation service disconnected",
					code !== 1000,
				),
			);
			client.on("message", (data, binary) => {
				if (ended) return;
				if (!ready || !lease.active()) {
					finish("Dictation session is not ready", true);
					return;
				}
				if (upstream.bufferedAmount > 128 * 1024) {
					finish("Audio upload cannot keep up", true);
					return;
				}
				if (binary) {
					if (Date.now() - secondStart >= 1000) {
						secondStart = Date.now();
						secondBytes = 0;
					}
					secondBytes += data.byteLength;
					bytes += data.byteLength;
					if (
						!data.byteLength ||
						data.byteLength % 2 ||
						data.byteLength > 6400 ||
						bytes > 90 * 32000 ||
						secondBytes > 64000
					) {
						finish("Audio limit exceeded", true);
						return;
					}
					upstream.send(data, { binary: true });
				} else {
					if (data.byteLength > 1024 || ++controls > 100) {
						finish("Audio control limit exceeded", true);
						return;
					}
					try {
						const message = JSON.parse(data.toString());
						if (
							Object.keys(message).length !== 1 ||
							!["KeepAlive", "Finalize", "CloseStream"].includes(message.type)
						)
							throw new Error();
						upstream.send(JSON.stringify({ type: message.type }));
					} catch {
						finish("Invalid audio control", true);
					}
				}
			});
		});
	};
	server.on("upgrade", upgrade);
	const close = () => {
		if (closed) return;
		closed = true;
		server.off("upgrade", upgrade);
		for (const finish of [...active]) finish("Service stopped");
		wss.close();
	};
	server.on("shutdown", close);
	server.on("close", close);
	return { close };
}
