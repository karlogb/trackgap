#!/usr/bin/env python3
"""Generates assets/shot-overview.png and assets/shot-2-recovery.png
from the real app/ui.html.

The UI is loaded in headless Chromium with a stubbed api() and demo data
(demo-store.com: 38 orders, 3 missing, 7.9 %, €34, dummy Measurement ID).
Both shots are 2560x1440 crops of the same page: overview starts at the top,
recovery is scrolled to "What is actually wrong" and "Conversion recovery".

Note: snap Chromium cannot read /tmp, so the harness is built in ~/.
Usage: python3 assets/make_shots.py
"""
import pathlib, re, subprocess, tempfile
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
# file name -> vertical crop offset in the full-page render
SHOTS = {"shot-overview.png": 0, "shot-2-recovery.png": 800}

STUB = """
// demo stub: overrides api() and fills the dashboard with data for the screenshot
const DEMO = {
  "/state": {ga4_connected:true, ga4_property_id:"properties/123",
             primary_domain:"demo-store.com", backfill_enabled:true,
             mp_measurement_id:"G-XXXXXXXXXX", meta_oauth_available:false},
  "/check": {
    summary:{missing_pct:7.9, missing:3, orders_compared:38, duplicates:0,
             orders_too_recent:2, ghosts:0},
    breakdown:{tracking_broken:2, consent_declined:1, no_identity:0, broken_pct:5.3},
    value_gap:{kind:"partial"},
    alerts:[],
    findings:[
      {type:"missing", severity:"high", count:3,
       detail:{pct:7.9, lost_revenue:34,
               by_source:{"google / cpc":2, "(direct)":1},
               order_numbers:["#11299","#11304","#11307"]}},
      {type:"value_note", severity:"info",
       detail:{note:"GA4 purchase value excludes shipping, so daily totals differ by the shipping cost.",
               revenue_orders:"€1,240", revenue_ga4:"€1,206"}}
    ]
  },
  "/backfill/stats": {stats:[
    {status:"sent", n:2},
    {status:"skipped", reason:"consent_denied", n:1}
  ]},
  "/history": [
    {ran_at:"2026-08-31T06:00", missing:3, missing_pct:7.9, duplicates:0},
    {ran_at:"2026-08-30T06:00", missing:3, missing_pct:8.1, duplicates:0},
    {ran_at:"2026-08-29T06:00", missing:2, missing_pct:5.4, duplicates:0},
    {ran_at:"2026-08-28T06:00", missing:2, missing_pct:5.6, duplicates:1},
    {ran_at:"2026-08-27T06:00", missing:1, missing_pct:2.8, duplicates:0}
  ],
};
// 30 days for the chart: deterministic, no randomness between runs
DEMO["/daily"] = Array.from({length:30},(_,i)=>{
  const d=new Date(2026,7,2+i);
  const orders=[1,2,1,0,2,1,3][i%7]+((i*7)%3);
  const missing=(i===9||i===17||i===26)?1:0;
  return {d:d.toISOString().slice(0,10), orders, missing:Math.min(missing,orders)};
});

api = async (path) => {
  const key = Object.keys(DEMO).find(k => path.startsWith(k));
  return {status:200, json:async()=>DEMO[key] ?? {}};
};

$("shopname").textContent=", demo-store.com";
show("dash");
STATE = DEMO["/state"];
loadBackfill(STATE);
render(DEMO["/check"]);
drawChart();
loadHistory();
"""

html = (ROOT / "app" / "ui.html").read_text()
# App Bridge from the CDN would only block load in a headless run
html = re.sub(r'<script src="https://cdn\.shopify\.com[^"]*"></script>', "", html)
# the stub goes at the end of the main <script> block
i = html.rindex("</script>")
html = html[:i] + "\n" + STUB + "\n" + html[i:]

with tempfile.TemporaryDirectory(dir=pathlib.Path.home()) as tmp:
    page = pathlib.Path(tmp) / "shot2.html"
    page.write_text(html)
    full = pathlib.Path(tmp) / "full.png"
    subprocess.run([
        "chromium-browser", "--headless=new", "--no-sandbox", "--disable-gpu",
        "--hide-scrollbars", "--window-size=1280,1300",
        "--force-device-scale-factor=2", f"--screenshot={full}", page.as_uri(),
    ], check=True, capture_output=True)
    im = Image.open(full)
    for name, y in SHOTS.items():
        out = ROOT / "assets" / name
        im.crop((0, y, 2560, y + 1440)).save(out, optimize=True)
        print(f"written {out} ({out.stat().st_size} bytes)")
