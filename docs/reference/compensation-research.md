# FlowJo compensation: second native pass

2026-10-17; FlowJo 11.2.0 `libNativeEngine.dylib`, observed SHA-256
`ba973647a4369f020e80fa23dc078ea116003c6127ef97f08cc16366388f8ab4`.
This inherits the packaged-integrity qualification in `flowjo-11-rea.md`.

## Coverage and evidence

Two supervised, targeted Ghidra 12.1.4 `-noanalysis` passes on Artemis produced
**35 bodies from 36 requested entrypoints**. `CompensationUtilities::CreateCompensationSpec`
hit its 45-second deadline; the failure is retained. Across the original and
second investigation, **54 unique native entrypoints** have successful pseudocode
outputs. This is not a percentage of the application or complete algorithm recovery.

Source-bound assembly/constants corroborate selected conclusions. All 73 output
files were checked against remote hashes after transfer. Both services ended with
empty control groups. No vendor code was executed. Results are direct Ghidra
research output, not canonical REA Evidence or native numerical parity.

Private evidence:
`~/Documents/flowjo-research/ses_eba830f19ffej2PuqaC4zed9va/compensation-wave2/`.

- Manifest SHA-256: `4cc12f06ae11fce311c5b3a722da9b94432a0c175fa471d8db6f3801a4d0313e`
- Research report SHA-256: `b53dabc85ff3c049ecd69b346c396907306f076711ddf9a049eedfec117416f3`
- Service wall times: 153.280 s and 53.558 s; summed function analysis 132.104 s.
  Queue/setup/teardown were not separately instrumented. Unreliable service memory
  accounting is not presented as measured peak RSS.

## Findings and implementation consequences

| Static observation | Consequence for Flow Atlas | Remaining evidence |
|---|---|---|
| Conventional processing gathers float inputs into double scratch, calls `LUBackSubstitute`, and writes float outputs | Our f32 WebGPU inverse/application needs explicit precision, condition and residual policy; do not claim native equivalence | Native asymmetric numerical fixtures and boundary cases |
| `UnmixWOLS` calls an `EigenSolver::Solve` overload applying a precomputed matrix via double BLAS GEMV | Keep setup/solver selection distinct from per-event application | Weighted objective, rank/conditioning policy and external coefficient orientation |
| SpectralFX uses a distinct worker and additional metadata including `SpectralEventWidth` | Expose as a separate unsupported capability until its inputs/objective are established | Worker dependencies, required metadata and validated outputs |
| Correction logic includes matrix-product preparation and max-absolute normalization; `HasCorrection` skips zero entries | Do not substitute an arbitrary inverse/product or infer behavior from the name | Asymmetric noncommuting correction fixtures, normalization axis and zero-entry cases |
| Preparation resolves detector/output lists through explicit name-to-ID lookups and distinct missing-channel errors | Use exact parameter identity and declared order, not first-N positional matching or stain labels | Cross-panel and imported compensation naming cases |
| FCS preprocessing/export handles time rescaling, scaling reversal, selected-channel adjustments, float conversion and byte order | Declare value spaces and acquisition scaling; export is an operation with provenance, not a raw array dump | `$PnE`, `$PnG`, `$TIMESTEP` and export-space fixtures |

The conventional row-vector contract `measured = true × spill` is independently
verified in FlowUtils's source. Native external orientation remains incompletely
traced. The current Flow Atlas implementation uses that explicit standard
mathematical contract and synthetic recovery tests, not copied native bodies.

## Next scientific slices

1. Named detector/fluorochrome rectangular OLS with rank and residual diagnostics.
2. Acquisition scaling with separate stored/linearized/compensated/display spaces,
   including time semantics and reproducible export conversion.
3. Correction and control-derived matrix estimation, validated independently.
4. Verified weighted/SpectralFX workflows after their objectives and metadata are
   known; do not label ordinary OLS as WLS/WOLS.

The private `oracle-plan.md` lists discriminating probes. Numerical fixtures,
readback tolerances, condition rejection and preprocessing choices must be explicit
before claiming compatibility with either FlowJo 10 or 11.
