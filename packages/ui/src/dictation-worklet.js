/* Audio transport formatting only, not a cytometry compute kernel.
 * Streaming box averaging is a modest anti-alias filter, not scientific DSP.
 * State is bounded to one 100 ms frame plus at most two in-flight port messages.
 */
class DictationProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.frame = new DataView(new ArrayBuffer(3200));
		this.count = 0;
		this.weight = 0;
		this.sum = 0;
		this.ratio = sampleRate / 16000;
		this.pending = 0;
		this.stopped = false;
		this.port.onmessage = ({ data }) => {
			if (data.type === "ack") this.pending = Math.max(0, this.pending - 1);
			if (data.type === "flush" && !this.stopped) {
				this.stopped = true;
				if (this.weight > 0) this.output(this.sum / this.weight);
				if (this.count > 0) this.emit();
				this.port.postMessage({ type: "flushed" });
			}
		};
	}

	emit() {
		const buffer = this.frame.buffer.slice(0, this.count * 2);
		this.port.postMessage({ type: "pcm", buffer }, [buffer]);
		this.pending++;
		this.count = 0;
	}

	output(value) {
		const clipped = Math.max(-1, Math.min(1, value));
		this.frame.setInt16(this.count * 2, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
		this.count++;
		if (this.count === 1600) {
			if (this.pending > 0) {
				this.stopped = true;
				this.port.postMessage({ type: "overflow" });
				this.count = 0;
			} else this.emit();
		}
	}

	process(inputs) {
		if (this.stopped) return true;
		const mono = inputs[0]?.[0];
		if (!mono) return true;
		for (const sample of mono) {
			let remaining = 1;
			while (remaining > 1e-9) {
				const take = Math.min(remaining, this.ratio - this.weight);
				this.sum += (Number.isFinite(sample) ? sample : 0) * take;
				this.weight += take;
				remaining -= take;
				if (this.weight >= this.ratio - 1e-9) {
					this.output(this.sum / this.weight);
					this.sum = 0;
					this.weight = 0;
					if (this.stopped) return true;
				}
			}
		}
		return true;
	}
}

registerProcessor("flow-atlas-dictation", DictationProcessor);
