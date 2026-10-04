// Test de charge sans dépendance, multi-processus (le générateur ne doit pas être le facteur limitant).
//   node tools/load-test.mjs <port> <scenario> <processus> <concurrence-par-processus> <requetes-par-processus>
//   ex. : node tools/load-test.mjs 5000 announcements 4 25 1000   (100 connexions simultanées)
// scénarios : services | announcements | me | health | login
// Crée (ou réutilise) le compte load_user@example.com : à supprimer ensuite, et à ne PAS lancer sur la production.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const [port, scenario, procs = "4", conc = "25", total = "800"] = process.argv.slice(2);

if (process.env.LOAD_CHILD) {
  const U = `http://localhost:${port}/api`;
  const H = { "content-type": "application/json" };
  const email = "load_user@example.com";
  let r = await fetch(`${U}/auth/login`, { method: "POST", headers: H, body: JSON.stringify({ email, password: "password123" }) });
  if (r.status !== 200) r = await fetch(`${U}/auth/register`, { method: "POST", headers: H, body: JSON.stringify({ email, password: "password123", firstName: "Load", lastName: "Test" }) });
  const token = (await r.json()).accessToken;
  const auth = { ...H, Authorization: `Bearer ${token}`, ...(process.env.ENC ? { "accept-encoding": process.env.ENC } : {}) };
  const call = {
    services: () => fetch(`${U}/services`, { headers: auth }),
    announcements: () => fetch(`${U}/announcements`, { headers: auth }),
    me: () => fetch(`${U}/auth/me`, { headers: auth }),
    health: () => fetch(`${U}/health`),
    login: () => fetch(`${U}/auth/login`, { method: "POST", headers: H, body: JSON.stringify({ email, password: "password123" }) }),
  }[scenario];
  const lat = [], codes = {};
  let next = 0;
  await new Promise((go) => process.once("message", go)); // départ synchronisé par le parent
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: Number(conc) }, async () => {
      while (next < Number(total)) {
        next++;
        const s = performance.now();
        try { const res = await call(); await res.arrayBuffer(); codes[res.status] = (codes[res.status] || 0) + 1; }
        catch { codes.ERR = (codes.ERR || 0) + 1; }
        lat.push(performance.now() - s);
      }
    })
  );
  process.send({ lat, codes, secs: (performance.now() - t0) / 1000 });
  process.exit(0);
} else {
  const kids = Array.from({ length: Number(procs) }, () => fork(fileURLToPath(import.meta.url), process.argv.slice(2), { env: { ...process.env, LOAD_CHILD: "1" } }));
  const results = [];
  const done = kids.map((k) => new Promise((res) => k.once("message", (m) => { results.push(m); res(); })));
  await new Promise((r) => setTimeout(r, 2500)); // laisse chaque enfant se connecter
  const t0 = performance.now();
  kids.forEach((k) => k.send("go"));
  await Promise.all(done);
  const secs = (performance.now() - t0) / 1000;
  const lat = results.flatMap((r) => r.lat).sort((a, b) => a - b);
  const codes = {};
  for (const r of results) for (const [c, n] of Object.entries(r.codes)) codes[c] = (codes[c] || 0) + n;
  const pct = (p) => Math.round(lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]);
  console.log(`${scenario.padEnd(14)} ${String(Math.round(lat.length / secs)).padStart(5)} req/s | p50 ${String(pct(50)).padStart(5)} ms | p95 ${String(pct(95)).padStart(5)} ms | p99 ${String(pct(99)).padStart(5)} ms | codes ${JSON.stringify(codes)} | ${Number(procs) * Number(conc)} connexions simultanées`);
}
