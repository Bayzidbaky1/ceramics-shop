// 100 buyers try to add the same product at once. Successes must never exceed the stock.
// Usage: node tests/oversell.js <base-url> <product-id>
const base = process.argv[2] || 'http://localhost:3000', pid = +process.argv[3] || 1;
(async () => {
  const before = (await (await fetch(base + '/api/drops')).json()).flatMap(d => d.products).find(p => p.id === pid);
  const codes = await Promise.all(Array.from({ length: 100 }, (_, i) =>
    fetch(`${base}/api/cart/test-${Date.now()}-${i}/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: pid }) }).then(r => r.status)));
  const ok = codes.filter(s => s === 200).length;
  console.log({ stockBefore: before.stock, added: ok, soldOut: codes.filter(s => s === 409).length, other: codes.filter(s => s !== 200 && s !== 409).length });
  console.log(ok <= before.stock ? 'PASS: never oversold' : 'FAIL: oversold');
})();
