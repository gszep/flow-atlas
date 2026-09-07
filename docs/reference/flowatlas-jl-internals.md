# FlowAtlas.jl internals — porting reference

Source of truth: `~/Documents/repos/FlowAtlas.jl` (v0.1.14) and its dependency
`FlowWorkspace.jl` (`~/.julia/packages/FlowWorkspace/hspM7/src`). Line numbers omitted; function names given.

## 1. Entry point `FlowAtlas.run(path; kwargs)` (`src/FlowAtlas.jl`)

Defaults: `port=3141, cols=:union, drop=String[], nlevels=10, nbins=50, heatmapQuantileEdge=0.1,
violinQuantileEdge=5e-5, channelScheme=reverse(ColorSchemes.matter), labelScheme=ColorSchemes.seaborn_colorblind`.

1. `data, labels, groups, gating = FlowWorkspace.load(path; files, cols)` — see §2.
2. Keep only **leaf** gates as population labels (`outdegree == 0` in each sample's gate graph), plus `"Unlabelled"`. Non-leaf populations are dropped from `labels` unless `drop` is used instead.
3. `names = (channels, populations, conditions, batches)`; groups whose name contains a digit are **batches** (donors like `390C`), otherwise **conditions** (tissues like `Spleen`). Heuristic — make it explicit metadata in the new model.
4. Embedding: `embed(data; path = <wsp basename>.som)` — see §3.
   Coordinates for the map are `(embedding[2,:], -embedding[1,:])` i.e. swapped and y-negated.
5. Colour LUTs:
   - labels: one hex colour per population from `labelScheme` spaced on `range(0,1)`, default row colour `#663F46`. `colors.labels.rows` is a 4×N RGBA channelview, rewritten per population via `colors!` (later populations overwrite earlier ones — order matters).
   - channels: per-channel `range(quantile(x, 0.1), quantile(x, 0.9), length=nlevels)`; `toIndex` maps each value to 1..nlevels, missing → nlevels+1 which is transparent RGBA(0,0,0,0).
6. Violin range: `quantile(all values across all channels, (5e-5, 1-5e-5))` → `nbins=50` bins.
7. Selections: `codes[i] = encode([labels[i,:]; groups[i,:]])` — a per-event integer bitmask over `[populations; conditions; batches]`, MSB = first name. `selections.names` = ordered dict name→bool, `selections.rows` = boolean mask.

HTTP routes (all JSON POST unless noted):

| Route | Handler | Semantics |
|---|---|---|
| `GET /{z}/{x}/{y}.png?channel=&scale=` | `tile` | 256² PNG tile of the embedding; see §4 |
| `POST /selection {name, selected}` | `selection!` | toggle one name, or a whole group (`"populations"`/`"conditions"`/`"batches"`), or `{name: {populations:[...], conditions:[...], batches:[...]}}` to **re-assign names between groups** (drag-and-drop legend) |
| `POST /colors {name, color}` | `colors!` | recolour all events where `labels[name]` or `groups[name]` is true |
| `POST /gate {id, coordinates}` | `gate` | polygon in embedding space → CSV of per-channel histograms (`nbins-1` rows, cols = channels + `channelValue` bin centres). Only events with `selections.rows` true are counted. Missing values skipped. |
| `GET /count` | `count` | `[{names: [...decoded names...], count}]` via `countmap(codes[rows])` |

Selection semantics (`selection!`): an event is visible iff
`codes & encode(selected)` ≠ 0 **and**, for each group (populations, conditions, batches) that is non-empty,
`codes & encode(selected) & groupMask ≠ 0` — i.e. it must have at least one selected member **in every group**.

## 2. `FlowWorkspace.load(path; files, cols)` (`Utils.jl`)

1. Parse `.wsp` XML (namespaces `gating`, `transforms`, `data-type` per Gating-ML 2.0). Asserts unique FCS basenames. Iterates `glob(files)`; for each FCS file finds `//DataSet[contains(@uri, basename)]`.
2. `load(path, sample)`:
   - `loadFCS` (FCSFiles.jl): keywords + data matrix; applies compensation if `$SPILL`/`$SPILLOVER`/`SPILL`/`SPILLOVER` exists: `data[:, cols] = data[:, cols] * inv(spill)`. **Note:** in the oracle data the FCS files are FlowJo-exported and already compensated (`FJComp-` channel names), so spill is absent.
   - Channel table via `findchannels(sample)`: reads `$PnN`, `$PnS`, `$PnE`, `$PnG`, `$PnR`, `$PnV`, `$PnB`, `$PnAR` from the sample's `<Keywords>` in the `.wsp` (not from the FCS!). Display name = `$PnS` if present else `$PnN` with a `stripname` fallback. Keeps only channels with `$PnE` present. Channel names must be unique.
   - Transforms via `transforms(sample)`: iterates `../Transformations/*` on the sample node; element name = transform type (`biex`, `linear`, `log`), attributes → kwargs, `data-type:parameter/@data-type:name` → channel via channelMap (`$PnN` → display name). Applied column-wise to the data. Unlisted channels are left untransformed.
   - Groups via `loadGroups`: all `GroupNode`s whose `SampleRefs/SampleRef[@sampleID]` includes this sample, excluding `"All Samples"` → boolean columns. (Also includes `"Compensation"` group in the oracle data.)
   - Gates via `gatingGraph(sample)` §2.1, then `gate(data, gating)` §2.2.
3. `append!(..., cols=:union)` across files → missing channels become `missing`. Labels/groups `missing → false`. Adds `"Unlabelled"` = no label true, `"Ungrouped"` = no group true.

### 2.1 `gatingGraph(sample)` (`Gating.jl`)

For every `Population` under the sample (`..//Population`, i.e. nested at any depth): `Gate/@gating:id`, `@gating:parent_id`; child element is `PolygonGate` or `RectangleGate` (anything else → assertion error). Dimensions: `gating:dimension/data-type:fcs-dimension/@data-type:name` → mapped to display names. Vertices/min/max are in **raw (untransformed) space**; the polygon is stored **after applying the channel transforms** to each vertex. Rectangle with 1 dimension → vertical band (y = ±Inf). Missing `gating:min`/`max` → ∓Inf. Polygon is closed by repeating the first vertex. Graph edge parent→child by id.

Oracle `workspace.wsp`: 33 DataSets, 1067 Population nodes, gate types = {PolygonGate, RectangleGate}, transforms = {biex}, groups = All Samples, 5 donors (`390C 403C 412C 423C 428C`), 9 tissues (`Blood BM Ileum Liver Lung mLN Spleen tLN`) + `Compensation`. 33 distinct population names (e.g. `CD4 | Naive`, `Treg | Foxp3+ Helios+`, `non-B`).

### 2.2 `gate(data, graph)` — label computation

Recursive from roots: `inside = inpolygon((x,y), polygon; in=true, on=false, out=false)` (PolygonOps.jl) ANDed with parent's mask. Name collisions between different gates with the same population name in one sample are silently merged (`unique(names)`, flagged `todo` in source). Multiple parents unsupported. Leaf populations then become the label columns in FlowAtlas.

## 3. Transforms (`Transforms.jl`) — port exactly

All transforms are materialised as a **lookup table + linear interpolation with flat extrapolation** (`LinearInterpolation(x, y; extrapolation_bc=Flat())`).

- `linear(minRange=0, maxRange=262144, gain=1)`: `y = gain*x` on integer grid.
- `log(offset=1, decades=1, minRange=0, maxRange=262144)`: `y = log10((x+offset)/decades)`. (Note: not FlowJo's exact log; unused in oracle data.)
- `biex(width=-10, neg=0, pos=4.418540, maxRange=262144, channelRange=4096, length=256)`: FlowJo biexponential, ported from FlowKit. Builds `positive` (x values, length `channelRange+1`) vs `values = 0..channelRange` (y). **Output is in 0..4096 "channel" units**, not decades. Algorithm:

```
width    = log10(-width)
decades  = pos - width/2
extra    = max(neg,0) + width/2
zero     = round((extra*channelRange)/(extra+decades)); zero = round(min(zero, channelRange/2))
if zero > 0: decades = extra*channelRange/zero
width    = width/(2*decades)
posRange = ln(10)*decades
negRange = _log_root(posRange, width)          # Newton/bisection solve of 2 ln(d) + w d + fb = 0, fb = -2 ln(b) + w b
n        = channelRange+1 ; v = 0..channelRange
positive = exp(v/n * posRange) ; negative = exp(-v/n * negRange)
s        = exp((posRange+negRange)*(width+extra/decades)) ; negative *= s
s        = positive[zero] - negative[zero]
positive[zero:] = maxRange/exp(posRange) * ((positive[zero:] - negative[zero:]) - s)
for i in 0..zero-1: positive[i] = -positive[2*zero - i]
table: x = positive, y = v
```

The oracle uses `width=-100, neg=0, pos=4.418539922, maxRange=262144, length=256` for every fluorescence channel (`FJComp-*`). Reference implementation to cross-check: FlowKit `flowkit/_utils/transforms.py` / `_models/transforms/_wsp_transforms.py` (`WSPBiexTransform`).

## 4. Embedding (`embed.jl`)

```
imputed = Impute.srs(data)   # per-column simple random sampling from observed values
som = initGigaSOM(imputed, 20, 20); som = trainGigaSOM(som, imputed)   # GigaSOM.jl defaults
clusters  = mapToGigaSOM(som, imputed)      # nearest codebook index per event
embedding = embedGigaSOM(som, imputed)      # N×2 EmbedSOM
```
Cached as serialised `som` at `<wsp>.som`; on load, re-maps and re-embeds (catches shape mismatch and retrains).
GigaSOM.jl `trainGigaSOM` defaults: `epochs=10`, `radiusFun=expRadius(-5.0)` from `rStart = √(xdim²+ydim²)/2 … rFinal=0.1`, `kernelFun=gaussianKernel`, batch SOM (codebook = kernel-weighted mean of assigned events). `embedGigaSOM` defaults: `k=10, adjust=1.0, smooth=0.0` (check the installed version for exact defaults). EmbedSOM reference: Kratochvíl, Koladiya, Vondrášek, F1000Research 2019/2020 and github.com/exaexa/EmbedSOM.

## 5. Tiles (`tile.jl`) — what the renderer must reproduce

Projection: OpenLayers pixel projection with `extent = [ymin, -xmax, ymax, -xmin]` of the embedding. Tile `z/x/y`: `tileSize = max(xrange, yrange)/2^z`, `x0 = xmin + x*tileSize`, padding = `tileSize/16`. Rasterise (GigaScatter `rasterize` 288² then `rasterKernelCircle(scale*√z)`) the visible+selected points with colour = channel LUT column or label RGBA, then crop 16px padding. Marker size slider `scale ∈ [0.01, 5]`. Tile URLs include `Math.random()` to bust cache after every selection/colour change. In the new app this whole path is replaced by direct GPU point rendering of the on-device buffers with per-event colour/visibility buffers updated in place.

## 6. UI (`sidebar.jl`, `map.jl`, `assets/*.js`)

- Sidebar (sidebar-v2 for OpenLayers) tabs: **Annotations** (colour-by `<select>` of `Labels` + channels; d3 colourbar; legend with three Sortable lists `populations / conditions / batches`, each `<li>` has a colour `<input>`, click toggles `selected`, header click toggles whole group, drag between conditions/batches lists re-assigns groups), **Expression** (Pan / Polygon / Delete buttons → OpenLayers Draw/Select interactions; each drawn polygon POSTs `/gate` and appends a violin row set (`violins.js`, one row per channel, `id` = feature uuid) ; Save → SVG via FileSaver), **Frequency** (Calculate → `/count` → `boxplots.js`: per population, boxes per condition, markers per batch coloured by legend colours; Save → SVG), **Settings** (marker size slider).
- `violins.js`: horizontal violins per channel, normalised density; `boxplots.js`: frequency = count / total selected per (batch, condition), grouped by population.

## 7. Test data on this machine

`~/Documents/repos/FlowAtlas.jl/data/`: `workspace.wsp`, `workspace.som` (cached SOM from a previous run — may not match current Julia env), 32 `.fcs` under `<donor>/` dirs (FlowJo-exported, compensated, ~19 fluorescence params + FSC/SSC/Time, three panels A/B/C with substituted markers — see paper §2.3). `test/data/` is a 16-file subset. Total events ≈ 3.88M (paper).
