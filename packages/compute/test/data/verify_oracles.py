"""Optional CPU-reference checker; never imported by production code or GPU tests."""
import os

for key in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[key] = "1"

import json
import hashlib
from pathlib import Path
import struct
from tempfile import TemporaryDirectory

import flowio
import flowutils
from flowutils.compensate import compensate_spectral_ols
import numpy as np

ROOT = Path(__file__).resolve().parent
assert (np.__version__, flowio.__version__, flowutils.__version__) == ("2.5.4", "1.4.0", "1.2.2")
spectral = json.loads((ROOT / "spectral-oracle.json").read_text())
for case in spectral["cases"]:
    s = np.asarray(case["S_fluor_by_detector"], dtype=np.float32).astype(np.float64)
    y = np.asarray(case["Y_event_by_detector"], dtype=np.float32).astype(np.float64)
    x, _, rank, _ = np.linalg.lstsq(s.T, y.T, rcond=-1)
    assert rank == case["rank"]
    x = x.T
    if case["full_rank"] and case["condition_number"] < 10:
        np.testing.assert_allclose(x, case["expected_X"], rtol=1e-12, atol=1e-10)
        np.testing.assert_allclose(np.linalg.norm(x @ s - y, axis=1), case["expected_residual_l2"], rtol=1e-12, atol=1e-10)
    np.testing.assert_array_equal(compensate_spectral_ols(y, s)[:, :len(s)], x)


def integer_fcs(path, case):
    channels = case["channels"]
    rows = case["stored"]
    words = dict(BEGINANALYSIS="0", ENDANALYSIS="0", BEGINSTEXT="0", ENDSTEXT="0",
                 BYTEORD="1,2,3,4", DATATYPE="I", MODE="L", NEXTDATA="0",
                 PAR=str(len(channels)), TOT=str(len(rows)))
    if case["timestep"] is not None:
        words["TIMESTEP"] = case["timestep"]
    for index, channel in enumerate(channels, 1):
        for suffix, value in dict(B=16, N=channel["name"], R=channel.get("range", 1024),
                                 E=channel.get("pne", "0,0"), G=channel.get("gain", 1)).items():
            words[f"P{index}{suffix}"] = str(value)
    payload = struct.pack("<" + "H" * (len(rows) * len(channels)), *(int(v) for row in rows for v in row))
    begin = 0
    while True:
        words["BEGINDATA"], words["ENDDATA"] = str(begin), str(begin + len(payload) - 1)
        text = ("|" + "|".join(v for pair in words.items() for v in ("$" + pair[0], pair[1])) + "|").encode("ascii")
        if begin == 58 + len(text):
            break
        begin = 58 + len(text)
    header = ("FCS3.1" + " " * 4 + "".join(f"{v:8d}" for v in [58, begin - 1, begin, begin + len(payload) - 1, 0, 0])).encode("ascii")
    path.write_bytes(header + text + payload)


acquisition = json.loads((ROOT / "acquisition-oracle.json").read_text())
with TemporaryDirectory(prefix="flow-atlas-reference-") as temporary:
    for index, case in enumerate(acquisition["cases"]):
        path = Path(temporary) / f"case-{index}.fcs"
        integer_fcs(path, case)
        assert hashlib.sha256(path.read_bytes()).hexdigest() == case["sha256"]
        source = flowio.FlowData(str(path))
        np.testing.assert_array_equal(source.as_array(preprocess=False), case["stored"])
        np.testing.assert_allclose(source.as_array(preprocess=True), case["flowio_preprocessed"], rtol=2e-15, atol=1e-14)

print(json.dumps({"spectral_cases": len(spectral["cases"]), "acquisition_cases": len(acquisition["cases"]),
                  "numpy": np.__version__, "flowio": flowio.__version__, "flowutils": flowutils.__version__, "result": "passed"}))
