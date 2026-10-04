// Vérification de l'assistant IA de rédaction d'alerte (POST /api/alerts/draft), scénario « montée de l'eau au sud ».
//   1. API locale (jamais en production) : PORT=5000 npm run dev
//   2. node tools/alert-draft-check.mjs 5000          -> attend un brouillon rédigé par l'IA
//      node tools/alert-draft-check.mjs 5000 template -> API lancée avec LLM_BASE_URL injoignable : attend le repli
// Crée des comptes « alr_*@example.com », des signalements et une alerte, et SUPPRIME tout ensuite.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [port = "5000", expected = "ai"] = process.argv.slice(2);
const U = `http://localhost:${port}/api`;
let pass = 0; const fails = [];
const check = (ok, t, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${t}${d ? "  — " + d : ""}`); ok ? pass++ : fails.push(t); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = (args) => execFileSync("npx", ["tsx", "tools/alert-check-db.ts", ...args], { cwd: apiDir, encoding: "utf8", shell: true });
process.on("exit", () => { try { db(["clean"]); } catch {} });

async function call(method, url, { token, body } = {}) {
  const res = await fetch(U + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const stamp = Date.now().toString(36);
async function register(label, role) {
  const t = (await call("GET", "/forms/token?form=register")).json;
  await sleep(t.minDelayMs + 100);
  const email = `alr_${label}_${stamp}@example.com`.toLowerCase();
  const res = await fetch(`${U}/auth/register`, { method: "POST", headers: { "content-type": "application/json", "x-form-token": t.token }, body: JSON.stringify({ email, password: "password123", firstName: label, lastName: "Draft", ...(role ? { role } : {}) }) });
  const j = await res.json();
  if (res.status !== 201) throw new Error(`inscription ${label} : ${res.status} ${JSON.stringify(j)}`);
  return { token: j.accessToken, email };
}

const [AD, AG, SA, H1, H2] = await Promise.all([register("Admin"), register("Agent"), register("Libre", "agent"), register("Hab1"), register("Hab2")]);
db(["roles", AD.email, AG.email]);

console.log("\n── Les habitants du sud signalent l'eau qui monte");
await call("POST", "/signalements", { token: H1.token, body: { type: "flood", location: "Rue des Serres, devant le n° 4", zone: "south", description: "Mon voisin M. Durand est diabétique et bloqué" } });
await call("POST", "/signalements", { token: H2.token, body: { type: "flood", location: "Canal sud, pont 2 (appelez-moi au 06 12 34 56 78)", zone: "south", lifeThreatening: true } });
await call("POST", "/signalements", { token: H1.token, body: { type: "heavy_rain", location: "Place du Marché", zone: "south" } });
await call("POST", "/signalements", { token: H2.token, body: { type: "fire", location: "Entrepôt nord", zone: "north" } });

console.log("\n── L'agent demande un brouillon à l'IA");
const t0 = Date.now();
let r = await call("POST", "/alerts/draft", { token: AG.token, body: { zone: "south" } });
const ms = Date.now() - t0;
const d = r.json?.draft;
check(r.status === 200 && d, "Brouillon obtenu", `${r.status} en ${ms} ms`);
check(r.json?.source === expected, `Rédigé par ${expected === "ai" ? "l'IA" : "le modèle de texte (repli)"}`, `source ${r.json?.source}, modèle ${r.json?.model}`);
console.log(`\n     TITRE      : ${d?.title}\n     GRAVITÉ    : ${d?.severity}\n     MESSAGE    : ${d?.message}\n     CONSIGNES  : ${d?.instructions?.map((i, n) => `\n       ${n + 1}. ${i}`).join("")}\n     DURÉE      : ${d?.expiresInMinutes} min\n`);
check(d?.hazard === "flood" && d.zones?.join() === "south", "Danger deviné à partir des signalements (inondation), quartier sud", `${d?.hazard} · ${d?.zones}`);
check(["warning", "emergency"].includes(d?.severity), "Une personne en danger a été signalée : au moins « alerte : protégez-vous »", d?.severity);
check(d?.instructions?.length >= 1 && d.instructions.every((i) => i.length <= 160), "Des consignes courtes « que faire »", `${d?.instructions?.length} consignes`);
check(r.json?.basedOn?.signalements === 3 && r.json.basedOn.urgent === 1, "Fondé sur les 3 signalements du sud (pas l'incendie du nord)", JSON.stringify(r.json?.basedOn));
const all = JSON.stringify(r.json);
check(!/06 12 34 56 78/.test(all) && !/Durand|diabétique/.test(all), "Aucune donnée personnelle : ni téléphone, ni description médicale envoyés ou rendus");
check(/relire/.test(r.json?.notice ?? ""), "Rappel : brouillon à relire avant publication");
check(!(await call("GET", "/public/alerts?zone=south")).json.active.some((a) => a.title === d?.title), "RIEN n'est publié automatiquement");

console.log("\n── L'agent relit et publie");
r = await call("POST", "/alerts", { token: AG.token, body: d });
check(r.status === 201, "Le brouillon est accepté tel quel par POST /api/alerts", `${r.status} ${r.json?.message ?? ""}`);
check((await call("GET", "/public/alerts?zone=south")).json.active.some((a) => a.id === r.json?.id), "Publié : visible par les habitants du sud");

console.log("\n── Garde-fous");
check((await call("POST", "/alerts/draft", { token: SA.token, body: { zone: "south" } })).json?.code === "agent_not_validated", "Agent non validé : refusé");
check((await call("POST", "/alerts/draft", { token: H1.token, body: { zone: "south" } })).status === 403, "Citoyen : refusé");
check((await call("POST", "/alerts/draft", { token: AG.token, body: { zone: "mars" } })).status === 400, "Quartier inconnu : 400");
r = await call("POST", "/alerts/draft", { token: AG.token, body: { zone: "east" } });
check(r.status === 422 && r.json?.code === "nothing_to_draft", "Aucun signalement et aucune note : rien à rédiger (422)");
r = await call("POST", "/alerts/draft", { token: AG.token, body: { zone: "east", hazard: "water_outage", notes: "Coupure d'eau prévue demain de 8 h à 12 h pour réparer une canalisation, contact chef.chantier@example.com" } });
check(r.status === 200 && r.json.draft.hazard === "water_outage" && !/chef\.chantier/.test(JSON.stringify(r.json)), "Avec une simple note de l'agent : brouillon obtenu, e-mail retiré", r.json?.draft?.title);

console.log(`\n══ BILAN : ${pass} vérifications réussies, ${fails.length} échec(s)`);
fails.forEach((f) => console.log("   ❌ " + f));
process.exit(fails.length ? 1 : 0);
