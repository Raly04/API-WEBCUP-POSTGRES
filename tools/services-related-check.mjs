// Vérification des 3 « autres services » renvoyés avec le détail d'un service (GET /api/services/:id -> related).
//   1. API locale (jamais en production) : PORT=5000 npm run dev
//   2. node tools/services-related-check.mjs 5000
// Crée des comptes « alr_*@example.com » et leurs demandes, supprimés ensuite (suppression en cascade).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [port = "5000"] = process.argv.slice(2);
const U = `http://localhost:${port}/api`;
let pass = 0; const fails = [];
const check = (ok, t, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${t}${d ? "  — " + d : ""}`); ok ? pass++ : fails.push(t); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = (args) => execFileSync("npx", ["tsx", "tools/alert-check-db.ts", ...args], { cwd: apiDir, encoding: "utf8", shell: true });
process.on("exit", () => { try { db(["clean"]); } catch {} });
const get = async (url, token) => { const r = await fetch(U + url, { headers: { authorization: `Bearer ${token}` } }); return { status: r.status, json: await r.json().catch(() => null) }; };
const stamp = Date.now().toString(36);
async function register(label) {
  const t = await (await fetch(`${U}/forms/token?form=register`)).json();
  await sleep(t.minDelayMs + 100);
  const email = `alr_${label}_${stamp}@example.com`.toLowerCase();
  const r = await fetch(`${U}/auth/register`, { method: "POST", headers: { "content-type": "application/json", "x-form-token": t.token }, body: JSON.stringify({ email, password: "password123", firstName: label, lastName: "Services" }) });
  const j = await r.json();
  if (r.status !== 201) throw new Error(`inscription ${label} : ${r.status} ${JSON.stringify(j)}`);
  return { token: j.accessToken, email };
}

const [A, B] = await Promise.all([register("Svc1"), register("Svc2")]);
const services = (await get("/services", A.token)).json;
const [s1, s2, s3, s4] = services;
let r = await get(`/services/${s1.id}`, A.token);
console.log(`\n── Détail de « ${s1.name} »`);
check(r.status === 200 && Array.isArray(r.json.related) && r.json.related.length === 3, "3 autres services renvoyés avec le détail", r.json?.related?.map((x) => `${x.name} (${x.reason})`).join(" | "));
check(r.json.related.every((x) => x.id !== s1.id && x.isActive && x.name && "averageRating" in x && x.icon !== undefined), "Jamais le service lui-même ; de quoi afficher une carte (nom, icône, description, note)");
check(r.json.id === s1.id && r.json.name === s1.name, "Le détail lui-même est inchangé");

console.log("\n── Deux habitants ont sollicité « " + s1.name + " » puis « " + s4.name + " »");
db(["requests", A.email, `${s1.id},${s4.id}`]);
db(["requests", B.email, `${s1.id},${s4.id},${s3.id}`]);
await sleep(31_000); // le cache des services liés dure 30 s
r = await get(`/services/${s1.id}`, A.token);
check(r.json.related[0].id === s4.id && r.json.related[0].reason === "often_together", "En premier : le service le plus souvent sollicité avec celui-ci", `${r.json.related[0].name} (${r.json.related[0].reason})`);
check(r.json.related.length === 3 && new Set(r.json.related.map((x) => x.id)).size === 3, "Toujours 3 cartes, sans doublon", r.json.related.map((x) => `${x.name} (${x.reason})`).join(" | "));
check((await get(`/services/999999`, A.token)).status === 404, "Service inconnu : 404");

console.log(`\n══ BILAN : ${pass} vérifications réussies, ${fails.length} échec(s)`);
fails.forEach((f) => console.log("   ❌ " + f));
process.exit(fails.length ? 1 : 0);
