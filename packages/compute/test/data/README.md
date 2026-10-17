# Independent numerical reference data

These small, synthetic records were generated with Python 3.12.13, NumPy 2.5.4,
FlowIO 1.4.0 and FlowUtils 1.2.2 on 2026-10-17. No donor events, proprietary
function bodies or production Python dependencies are included.

`spectral-oracle.json` stores F32-quantized reference matrices/events and the
float64 NumPy `lstsq(S.T, Y.T, rcond=-1)` solution and L2 residual. FlowUtils calls
the same NumPy solver; its agreement verifies wrapper/axis behavior, not a second
independent numerical algorithm. The GPU implementation uses pivoted QR. Degenerate
and ill-conditioned cases are rejection probes, not requirements to accept the
recorded minimum-norm answers. Permutation cases carry their actual axis names.

`acquisition-oracle.json` records actual FlowIO reads of synthetic integer FCS,
with original channel metadata and stored/preprocessed outputs. The fixture's
`channels` preserve original Time gain and zero log-offset values; FlowIO's parsed
metadata may have normalized them already. Nonlinear Time is explicitly a rejected
profile case even though FlowIO returns a value. Compatibility cases are not a
separate FCS-standards conformance audit.

`independent-oracles.test.ts` applies a normalized tolerance of `1e-5` to accepted
GPU results. This is a test tolerance on these fixtures, not a universal accuracy
bound or FlowJo parity claim. Standard CI reads JSON and requires no Python.

Optional independent recheck (use an isolated environment):

```sh
python -m pip install -r packages/compute/test/data/requirements-oracle.txt
python packages/compute/test/data/verify_oracles.py
```

The checker reconstructs synthetic integer FCS in a temporary directory and checks
the stored spectral inputs directly. It never overwrites the committed records.
BLAS builds can differ in final float64 rounding; source inputs and numerical
tolerances are explicit. Original generation/provenance, including source hashes,
is retained in the private research directory `spectral-oracles` named in the
repository's research handoff.

Primary source pins:
- FlowIO: `83d28a22d42235c10d17afb017250ee208afed95`, `src/flowio/flowdata.py`.
- FlowUtils: `b3aa2708eb25953e4e4dd9f9edcba3d503297e50`, `src/flowutils/compensate.py`.

The installed implementations used for generation were byte-identical to those
source files. Each JSON file records its original research-record hash and package
versions in `provenance`.
