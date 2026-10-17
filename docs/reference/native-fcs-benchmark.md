# Bounded native FCS pipeline: measured baseline

Measured 2026-10-17 on Calcifer, Node 24.18.0, Intel UHD Graphics 630 / Metal,
macOS 15.7.9 (24G830). Scientific processing used the real WebGPU compensation
backend. This is a single-device baseline, **not a Rust comparison**, warm-run
distribution, or general cytometry performance guarantee. OS/driver caches were
not cleared.

## Corrected-build run

Source commit: `bc82737ba9d9c40eac895ae6414f0f52393d44dc`.
Bundled source/dependency fingerprint:
`621d249b5810ab97dc6a02a287dba73e72670bba46f27eccfb15767c83a61551`.

The workload generated 50,000,000 events × 20 F32 channels in chunks: a
**4,000,000,000-byte DATA payload**. Two channels used an asymmetric conventional
spill matrix; the other 18 exercised unchanged-channel handling. It then copied
and hashed the input, validated metadata, prepared compensation, streamed the
entire compensated export, re-read output metadata and checked selected event
values, including chunk boundaries and the final event.

| Measurement | Result |
|---|---:|
| Decoded event chunk budget | 4 MiB |
| Peak host-process RSS, OS high-water report | 353,558,528 bytes (337.2 MiB) |
| Watchdog-sampled peak RSS | 353,665,024 bytes |
| Synthetic file generation | 14.397 s |
| Input snapshot/import, including descriptor-bound verification | 34.817 s |
| GPU initialization and matrix validation | 0.121 s |
| Export job wall time | 58.633 s |
| Job queue wait | 0.031 s |
| Job setup, including input verification | 15.304 s |
| Job processing, including decode/compute/readback/write | 43.228 s |
| Total before cleanup, including generation | 107.985 s |
| Supervised total, including cleanup | 108.945 s |
| Payload / export-job wall time | 68.22 MB/s |
| Maximum error at sampled output coordinates | 0.00000762939453125 |

The watchdog sampled RSS every 0.5 seconds with a 2 GiB termination threshold,
a 900-second wall deadline, and a 120-second no-progress deadline. Node's heap
limit was 512 MiB. It did not terminate the run. The benchmark's own OS high-water
check also passed the 2 GiB target. Invocation-owned temporary input/cache/output
directories were removed. This is an observed RSS bound with a watchdog, not a
kernel-enforced process-tree memory reservation. GPU allocation high-water was
**not instrumented**; stage timings do not separately isolate upload, kernel and
readback time.

Input SHA-256:
`73f84c95bf43880e7329431b6c2daf58617121339dd62360c1bb0a9474904756`.

Output SHA-256:
`400e655ef994bdcfbe70fbb088810ec6aea524f9d20fca6b87ebb164ba573ebc`.

The source/output hashes match the earlier pre-review-fix 4 GB run, despite the
added descriptor-bound verification. That comparison supports byte-for-byte
consistency for these two runs on this backend. The numerical spot checks are
not an independent exhaustive oracle for all billion stored channel values.

## Earlier measurements and interpretation

An earlier 1M-event / 80 MB payload run used approximately 230 MB peak host RSS.
The pre-review-fix 4 GB run used approximately 377 MB RSS and 62.2 s for export.
Those records retain their distinct build fingerprints. Differences in throughput
between these single runs are not attributed to an optimization or language effect.

The corrected pipeline demonstrates a 4 GB input can be processed without a
whole-file event array in host memory. It does not prove every Flow Atlas workflow
has bounded memory: the older full-sample gate pipeline still retains per-gate
masks, and browser rendering/embedding have separate memory behavior.

The compiled Linux/llvmpipe smoke and Metal smoke both passed numerical tolerances,
but their output file hashes differed. Artifact hashes identify exact bytes;
cross-backend floating-point equivalence requires a stated numerical tolerance,
not an assumption of identical binary output.

## Reproduction

Build the host, then run the committed developer benchmark:

```sh
pnpm typecheck
pnpm --filter @flow-atlas/host build
NODE_OPTIONS=--max-old-space-size=512 node packages/host/bench/streaming.mjs \
  --events 50000000 --workdir /path/with/enough/free/space \
  --result /path/to/new-result.json
```

The source, immutable snapshot and staged output need roughly three payloads of
temporary disk space. The benchmark removes its owned directory unless `--keep`
is selected. It refuses to overwrite an existing result file and refuses to label
software-adapter throughput as a hardware benchmark. The RSS/progress supervisor
used for this measurement and original JSON/logs are retained privately under
`~/Documents/flowjo-research/ses_eba830f19ffej2PuqaC4zed9va/benchmarks/`.

## Rust decision

This establishes a useful Node/Dawn baseline and removes “requires whole-file RAM”
as a reason to rewrite this path. It establishes **no relative Rust advantage**.
Profile the combined processing time and compare a Rust/wgpu worker using the
same input, hardware, kernels, precision and validation before adopting one.
See `programmatic-cytometry.md` for references and proposed adoption thresholds.
