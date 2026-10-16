# FCS binary I/O

Zero runtime dependencies; CPU work is binary parsing/serialization only. Neither
reader applies gain, amplification, or compensation. No CPU numerical fallback.

## Bounded random-access reader

```ts
const reader = await openFcs(blobSource(file), { signal });
// reader.metadata: Omit<FcsFile, "data">
// reader.countPolicy === "exact-declared"
for await (const { start, count, data } of reader.chunks({
  chunkEvents: 4096, startEvent: 0, eventCount: 10000, signal,
})) {
  // start is absolute, zero-based; data is event-major Float32Array.
}
```

`FcsByteSource` has `size: number` and
`read(offset: number, length: number): Promise<Uint8Array>`. Reads must return
exactly the requested bytes, including when using a Node file handle. No file
handle is opened or closed by this package; the source is borrowed and must stay
stable throughout consumption. Sources can implement their own positional I/O,
retry and resource ownership. `blobSource(blob)` uses `Blob.slice().arrayBuffer()`
only for requested ranges.

`openFcs` reads the 58-byte header and primary/supplemental TEXT, never DATA or a
prefix up to DATA. Combined TEXT is capped at 16 MiB encoded bytes, channels at
65,536, and spill matrices at 2,097,152 coefficients. Parsed strings/objects have
additional bounded representation overhead; these limits are not a total JS-heap
size promise. Every chunk's **source bytes plus decoded output bytes** is at most
128 MiB. Defaults target about 1 MiB source reads. Requested `chunkEvents` above
the safe limit rejects rather than silently changing the request. No prefetching;
one source read is awaited at a time. Retaining emitted chunks is caller-owned
memory, not bounded by the reader.

Only list-mode, single-dataset FCS 2.0/3.0/3.1 is supported. F32, F64 (rounded to
F32), byte-aligned unsigned I8/I16/I24/I32/I64, and ascending/descending byte order
are supported. Integers retain the existing range-mask decoding convention;
64-bit masks are applied before floating-point rounding. Unsupported packing and
byte order reject. DATA offsets are inclusive; conflicting nonzero header/TEXT
offsets reject. `$TOT` must exactly match the DATA byte extent and source size must
contain that extent. There is no silent truncation. Actual reads validate lengths
as well; metadata inspection is not a proof that an external source will remain
readable or unchanged later. `eventCount` is the **declared, extent-validated**
count, not a count of already-read events. Zero-event files deliberately use zero
DATA offsets, retain at least one channel, and yield no event chunks.

`signal` is checked before and after awaited reads, before metadata emission, and
at event/output chunk boundaries, including empty iterations. An already-pending
custom source read or input iterator cannot be forcibly interrupted by this
interface; its owner must implement transport cancellation/timeouts. Cancellation
throws `FcsError("FCS operation aborted")`. Source/iterator errors propagate.

The existing `readFcs(ArrayBuffer, options?)` remains the eager compatibility API,
including its historical truncation-to-available-events policy. `headerOnly`
remains metadata-only. Prefer `openFcs` for strict counts and bounded memory.

## Streaming writer

```ts
for await (const bytes of writeFcs(metadata, eventChunks, {
  chunkBytes: 1024 * 1024, signal,
})) {
  await temporarySink.write(bytes);
}
// Publish the completed sink only after iteration finishes successfully.
```

`eventChunks` is `AsyncIterable<Float32Array> | Iterable<Float32Array>`; each
input chunk must contain complete event rows and be at most 128 MiB. The writer
borrows one input chunk at a time (keep it stable until consumed), holds bounded
TEXT, and allocates only one output chunk at a time. `chunkBytes` is an integer
from 4 through 128 MiB and caps **every** yielded byte array, including header and
TEXT; output chunks need not end at event boundaries. The writer does not own or
buffer a sink. Errors, cancellation, or early iterator return leave partial output
which the caller **must discard**, not publish. Once started, the input iterator
is closed on writer failure/early return. The writer checks for excess input even
after the expected number of values has arrived; iterate to completion.

Output is FCS3.1 F32 little-endian. It regenerates `$PAR`, `$TOT`, `$DATATYPE`,
`$BYTEORD`, offsets, `$MODE`, `$NEXTDATA`, and sequential `$Pn` fields from the
channel array, not the supplied `channel.index`. Old parameter fields, ANALYSIS,
supplemental TEXT pointers and `$UNICODE` are removed/regenerated. Other valid
keywords are retained (case-insensitively). Large DATA offsets use both zero
header fields and exact decimal TEXT offsets. No entire output accumulation or
DATA prepass is required; the caller supplies the exact event count up front.

`$PnE` is always `0,0`; nonzero amplification **rejects**, rather than claiming raw
logarithmic integers were converted to linear floats. Non-unit gain also rejects
until an upstream numerical stage explicitly converts values and updates channel
metadata to unit gain. This is a conservative export capability boundary, not a
claim that FCS float data can never carry a non-unit gain. Negative and above-range
values are preserved, not clamped.

All spill keyword aliases are discarded. Only explicit `metadata.spill` creates
canonical `$SPILLOVER`, with exact dimensions, unique/nonempty channel names that
exist in the export, and finite coefficients. To export already compensated data,
omit `metadata.spill`; stale text cannot trigger accidental double compensation.
Spill matrix convention: row-major `S`, recorded row `y = true row x * S`.

## TEXT encoding and compatibility

Both readers default to **strict UTF-8**, matching the writer. Offsets count
encoded bytes, not UTF-16 string units. Invalid UTF-8 is an explicit error; legacy
single-byte data requires `{ textEncoding: "latin1" }` (the WHATWG decoder uses
Windows-1252). The writer always emits UTF-8, rejects invalid Unicode, NUL and
empty keyword/value strings, and doubles embedded delimiters. It selects a
different ASCII delimiter when a token starts with the preferred one, avoiding
ambiguous leading-delimiter escapes. If no unambiguous delimiter exists it
rejects. Unicode round trips are tested locally; interoperability with all
historical cytometry tools is not claimed.

Primary-source checks (2026-10-17): FlowIO `src/flowio/create_fcs.py` confirms
UTF-8 TEXT, inclusive offsets, zero header offsets above 99,999,999, F32 output,
and zero `$PnE`. FlowUtils `src/flowutils/compensate.py` uses the transposed spill
solve and row-by-matrix inverse compensation matching the convention above.
This package implements its own bounded I/O; it does not copy either algorithm
or implement numerical compensation.
