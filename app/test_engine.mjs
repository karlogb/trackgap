import { reconcile } from "./reconcile.mjs";

const old = (d) => new Date(Date.now() - d*86400000).toISOString();

// 100 orders, all old enough
const orders = Array.from({length:100},(_,i)=>({
  order_id:`${1000+i}`, order_number:`#${1000+i}`, total:50+i,
  created_at: old(5+i%20), utm_source: i%3===0?"google":i%3===1?"facebook":null,
}));
// 3 brand-new ones: must not be compared
orders.push(...[1,2,3].map(i=>({order_id:`NEW${i}`,order_number:`#NEW${i}`,
  total:10,created_at:new Date().toISOString()})));

// GA4 has only 82 of them, 5 duplicates, 1 ghost
const ga4 = orders.slice(0,82).map(o=>({transaction_id:o.order_id,
  revenue:o.total, event_count:1, source:o.utm_source||"(direct)"}));
ga4.slice(0,5).forEach(g=>g.event_count=2);
ga4.push({transaction_id:"GHOST-1",revenue:99,event_count:1,source:"x"});

const r = reconcile(orders, ga4);
console.log("SUMMARY:", JSON.stringify(r.summary,null,1));
console.log("\nFINDINGS:");
for (const f of r.findings) {
  console.log(` [${f.severity.toUpperCase()}] ${f.type} x${f.count}`);
  if (f.type==="missing") console.log(`   ${f.detail.pct}% | sources:`, f.detail.by_source,
     `\n   first: ${f.detail.order_numbers.slice(0,5).join(", ")}`);
  if (f.type==="revenue_gap") console.log(`   ${f.detail.pct}% (store ${f.detail.revenue_orders} vs GA4 ${f.detail.revenue_ga4})`);
}
// check
const ok = r.summary.orders_too_recent===3 && r.summary.missing===18 && r.summary.duplicates===5;
console.log("\nTEST:", ok ? "PASSED" : "FAILED");
