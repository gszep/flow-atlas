# Control-derived compensation: evidence and implementation boundary

Static investigation, 2026-10-17. Observed FlowJo 11.2 engine SHA-256:
`ba973647a4369f020e80fa23dc078ea116003c6127ef97f08cc16366388f8ab4`.
The packaged-integrity qualification from `flowjo-11-rea.md` still applies.

## Additional coverage

This pass requested 18 targeted native entrypoints and recovered 17. The dispatcher
`Spillover::ProcessQuery` timed out at its 45-second deadline and was not retried.
All 37 returned files were hash-verified; both supervised Artemis jobs drained and
their temporary projects were deleted. Combined with earlier passes, **71 unique
entry addresses** now have recovered pseudocode. This is not a percentage of the
application or a count of independently verified algorithms.

The direct Ghidra 12.1.4 `-noanalysis` runs took 130.763 s and 68.225 s. The first
returned failure to retain the timeout; the second completed successfully. No
vendor code was executed. Pseudocode can absorb tail-call/downstream bodies, so
entry addresses, assembly and body ranges remain important. No native numerical
parity follows from successful decompilation.

Private evidence is in
`~/Documents/flowjo-research/ses_eba830f19ffej2PuqaC4zed9va/control-estimation-wave3/`:
`REPORT.md`, `manifest.json`, source/transfer manifests, recovered bodies,
`future-contract.json`, and `oracle-plan.md`.

## Findings that guide the next capability

| Entry / declaration | Observation | Boundary |
|---|---|---|
| `CalculateTraditionalSpillover`, `0x2122670` | Positive-minus-negative statistic values; type 13 is corroborated as `MedianExact` through enum assembly/jump table | Even-N median/interpolation and final intermediate-field mapping are not fully traced |
| Positive-primary branch | Divides detector differences by the primary-detector median separation | Supports a narrowly named median-difference/primary-normalized profile, not every native branch |
| `NormalizeSpilloverMatrix`, `0x21450d0` | Uses the ordinary signed maximum and divides only when positive | Different from the correction-product path's maximum-absolute normalization |
| `CalculateTraditionalSpread`, `0x2136200` | Uses Q50/Q84 positive/negative widths and primary separation; helper resolves to `PercentileExact` | Percentile interpolation and complete nonfinite policy still require fixtures |
| `CalculateSpill`, `0x21234f0` | Separate gathering branches, 1st/99th percentile calculations and a named `FitLinearModel` call | This is not a recovered complete robust/iterative estimator |
| `CalculateResidualSpillover`, `0x2144920` | Residual-evaluation machinery; requests include `pcutoff`/`errorTarget` | Defaults, objectives, update/convergence/fallback rules remain unknown |

Control declarations distinguish chosen settings from inferred settings and allow
a separately bound negative data source. A control API must retain exact positive
and negative selections, input space, channel identities, support, and lineage.
It must not assume negatives are in the same file or turn an inferred gate into a
human-finalized choice.

For the selected conventional profile, the intended mathematical contract is:

`S[i,j] = (median(positive_i[j]) - median(negative_i[j])) /
          (median(positive_i[i]) - median(negative_i[i]))`.

Require a positive, finite primary separation and explicit support policy. Preserve
negative off-diagonal coefficients rather than clipping them. Odd/even median-rank
endpoints and F32 arithmetic must be specified; do not name the result `MedianExact`
vendor parity without native fixtures. Maximum-normalized spectra are a different
profile and are not substituted for primary normalization.

## Keep alternative estimators distinct

The checked Cytoflow control estimator fits through-origin regression after its
own filtering. The checked AutoSpill R code uses intercept-bearing robust fitting
and iterative refinement with diagonal normalization. FlowKit's inspected methods
provide matrix application and gating context, not evidence of an equivalent
control-to-matrix estimator. These are useful independent references, not aliases
for one algorithm or proof of native behavior.

AutoSpill's robust weighting, branch selection and convergence, AutoSpread's full
objective, and native gate-inference fallbacks remain unresolved. No universal
`qcPassed` threshold should be invented from the presence of QC fields. Count,
separation, finite support, conditioning, residual/baseline mismatch and context
staleness are distinct observations.

## Implemented capability sequence

1. Bounded replayable GPU rank selection over explicit control selections, retaining
   median endpoints and selected support without materializing whole populations.
2. A GPU primary-normalized median-difference matrix primitive with transparent
   support/separation/numerical rejection.
3. Agent-job orchestration binding immutable control artifacts, selections and input
   contexts, followed by the existing matrix conditioning validation and receipts.

These slices now compose in the agent API's `start_control_estimation`. GPU
primitives passed independent reviews; host review identified and verified fixes
for temporal detector roles, pre-admission threshold validation and MCP receipt
budgets. Synthetic end-to-end and compiled protocol validation exercise the named
mathematical profile, not vendor code. AutoSpill and automatic positive/negative
inference remain unavailable. Native equivalence requires independent native fixtures.
