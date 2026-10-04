// Vérification de bout en bout : « lors d'un incident, je veux au moins consulter les informations essentielles, les
// consignes et les coordonnées utiles ».
//   1. API locale (jamais en production) : PORT=5000 npm run dev
//   2. node tools/essentials-check.mjs 5000
// Les pannes sont simulées par des instances SUPPLÉMENTAIRES de l'API (ports +1 et +2) branchées sur une base injoignable :
// la vraie base n'est jamais arrêtée. Crée des comptes « alr_*@example.com » et des contacts « [test] ... », supprimés ensuite.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [port = "5000"] = process.argv.slice(2);
const BASE = `http://localhost:${port}`;
const NOTICE_FILE = path.join(apiDir, "data", "platform-notice.json");
let pass = 0; const fails = [];
const check = (ok, t, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${t}${d ? "  — " + d : ""}`); ok ? pass++ : fails.push(t); };
const section = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = (args) => execFileSync("npx", ["tsx", "tools/alert-check-db.ts", ...args], { cwd: apiDir, encoding: "utf8", shell: true });
const children = [];
let noticeCreatedByTest = false;
process.on("exit", () => {
  for (const child of children) try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { try { child.kill(); } catch {} }
  if (noticeCreatedByTest) try { fs.unlinkSync(NOTICE_FILE); } catch {}
  try { db(["clean"]); } catch {}
});

async function call(method, url, { token, body, headers = {}, base = BASE } = {}) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}
const stamp = Date.now().toString(36);
async function register(label, role) {
  const t = (await call("GET", "/api/forms/token?form=register")).json;
  await sleep(t.minDelayMs + 100);
  const email = `alr_${label}_${stamp}@example.com`.toLowerCase();
  const r = await call("POST", "/api/auth/register", { body: { email, password: "password123", firstName: label, lastName: "Secours", ...(role ? { role } : {}) }, headers: { "x-form-token": t.token } });
  if (r.status !== 201) throw new Error(`inscription ${label} : ${r.status} ${r.text}`);
  return { token: r.json.accessToken, email };
}
async function startOutage(offset, env) {
  const outagePort = String(Number(port) + offset);
  const child = spawn("npx", ["tsx", "src/index.ts"], { cwd: apiDir, shell: true, stdio: "ignore", env: { ...process.env, PORT: outagePort, DB_PORT: "1", SEED_ON_START: "false", LOG_REQUESTS: "errors", DB_READ_TIMEOUT_MS: "1500", ...env } });
  children.push(child);
  const base = `http://localhost:${outagePort}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + "/api/health")).ok) break; } catch {} await sleep(500); }
  return base;
}

const [AD, AG, SA, HAB] = await Promise.all([register("Admin"), register("Agent"), register("Libre", "agent"), register("Hab")]);
db(["roles", AD.email, AG.email]);

section("1. LES CONSIGNES : « QUE FAIRE EN CAS DE... », TOUJOURS DISPONIBLES");
let r = await call("GET", "/api/public/guide");
check(r.status === 200 && r.json.entries.length >= 10 && r.json.kit.fr.length >= 8, "Guide complet, sans compte", r.json?.entries?.map((e) => e.key).join(", "));
const flood = r.json.entries.find((e) => e.key === "flood");
check(flood.during.fr.some((l) => l.includes("112")) && !JSON.stringify(r.json).includes("{emergency}"), "Le numéro d'urgence est écrit dans les consignes", flood.during.fr.at(-1));
check(flood.before.fr.length && flood.during.fr.length && flood.after.fr.length && flood.during.en.length === flood.during.fr.length, "Avant / pendant / après, en français et en anglais");
check((await call("GET", "/api/public/guide/network")).json?.title?.fr === "Panne de réseau ou de la plateforme" && (await call("GET", "/api/public/guide/volcan")).status === 404, "Une consigne précise (clé = danger de l'alerte), 404 sinon");

section("2. LES COORDONNÉES UTILES");
r = await call("GET", "/api/public/contacts");
check(r.status === 200 && r.json.categories[0].category === "emergency" && r.json.categories[0].contacts[0].phoneHref === "tel:112", "Urgences en premier, avec lien d'appel direct", `${r.json?.categories?.[0]?.contacts?.[0]?.label} → ${r.json?.categories?.[0]?.contacts?.[0]?.phoneHref}`);
check(r.json.categories.map((c) => c.category).join(",").startsWith("emergency,crisis,health,shelter"), "Dans l'ordre où on les cherche : urgences, crise, santé, abris...", r.json.categories.map((c) => c.category).join(" > "));
r = await call("GET", "/api/public/contacts?zone=south");
const labels = r.json.categories.flatMap((c) => c.contacts.map((x) => x.label));
check(labels.includes("Abri du Dôme Sud") && !labels.includes("Centre médical du Dôme Nord") && labels.includes("Cellule de crise municipale"), "Mon quartier (sud) : ses lieux + les contacts de toute la ville, pas ceux du nord");
check((await call("GET", "/api/public/contacts?zone=mars")).status === 400, "Quartier inconnu : 400");

section("3. LE PERSONNEL LES TIENT À JOUR PENDANT LA CRISE");
const SHELTER = { label: "[test] Abri du gymnase sud", category: "shelter", address: "Rue des Serres, gymnase", zone: "south", openingHours: "Ouvert pendant l'alerte" };
check((await call("POST", "/api/contacts", { token: HAB.token, body: SHELTER })).status === 403, "Un citoyen ne peut pas modifier l'annuaire");
check((await call("POST", "/api/contacts", { token: SA.token, body: SHELTER })).json?.code === "agent_not_validated", "Un agent non validé non plus");
for (const [body, what] of [
  [{ label: "[test] Sans moyen", category: "other" }, "ni téléphone, ni e-mail, ni adresse"],
  [{ ...SHELTER, phone: "appelez-moi" }, "téléphone invalide"],
  [{ ...SHELTER, zone: "mars" }, "quartier inconnu"],
  [{ ...SHELTER, category: "bunker" }, "catégorie inconnue"],
  [{ ...SHELTER, email: "pas-un-mail" }, "e-mail invalide"],
]) check((await call("POST", "/api/contacts", { token: AG.token, body })).status === 400, `Refusé : ${what}`);
r = await call("POST", "/api/contacts", { token: AG.token, body: SHELTER });
const shelterId = r.json?.id;
check(r.status === 201, "Un agent validé ouvre un abri", `${r.status} ${r.json?.message ?? ""}`);
check((await call("GET", "/api/public/contacts?zone=south")).json.categories.find((c) => c.category === "shelter").contacts.some((c) => c.id === shelterId && c.isOpen), "Visible tout de suite par les habitants du sud");
r = await call("PATCH", `/api/contacts/${shelterId}`, { token: AG.token, body: { isOpen: false, statusNote: "Complet : rejoignez l'Abri du Dôme Sud" } });
const shown = (await call("GET", "/api/public/contacts?zone=south")).json.categories.find((c) => c.category === "shelter").contacts.find((c) => c.id === shelterId);
check(r.status === 200 && shown.isOpen === false && /Complet/.test(shown.statusNote), "Abri complet : l'état et la consigne sont à jour", shown?.statusNote);
const xss = await call("POST", "/api/contacts", { token: AG.token, body: { label: "[test] <script>alert(1)</script> Point d'eau", category: "water", address: "<img src=x onerror=alert(1)>" } });
check(xss.status === 201, "Contenu piégé accepté comme texte (il sera échappé)");

section("4. AVIS D'INCIDENT : SAVOIR CE QUI MARCHE ENCORE");
const before = (await call("GET", "/api/status")).json;
if (before.notice) {
  console.log("  ⚠️  Un avis d'incident réel est en cours : partie ignorée pour ne pas l'écraser");
} else {
  const NOTICE = { message: "Incident en cours : les rendez-vous et les demandes en ligne sont indisponibles. Les alertes, les consignes et les coordonnées utiles restent consultables.", severity: "warning", affected: ["account"] };
  check((await call("PUT", "/api/platform/notice", { token: AG.token, body: NOTICE })).status === 403, "Un agent ne publie pas d'avis d'incident (administrateur)");
  check((await call("PUT", "/api/platform/notice", { token: AD.token, body: { ...NOTICE, message: "court" } })).status === 400 && (await call("PUT", "/api/platform/notice", { token: AD.token, body: { ...NOTICE, affected: ["tout"] } })).status === 400, "Message trop court ou fonction inconnue : 400");
  r = await call("PUT", "/api/platform/notice", { token: AD.token, body: NOTICE });
  noticeCreatedByTest = r.status === 200;
  check(r.status === 200 && r.json.affected[0] === "account", "L'administrateur publie l'avis");
  r = await call("GET", "/api/status");
  const account = r.json.features.find((f) => f.key === "account");
  check(r.json.status === "incident" && r.json.message.fr === NOTICE.message && account.available === false && account.declaredByNotice, "État des services : l'avis en tête, la fonction touchée marquée indisponible", r.json.message.fr);
  check(r.json.features.filter((f) => ["emergency", "guide", "alerts", "contacts", "transport"].includes(f.key)).every((f) => f.available), "… et tout ce qui reste consultable : urgence, consignes, alertes, coordonnées, transports");
}

section("5. LE KIT ESSENTIEL (À GARDER SUR LE TÉLÉPHONE)");
r = await call("GET", "/api/public/essentials");
check(r.status === 200 && r.json.emergency.href === "tel:112" && r.json.guide.entries.length >= 10 && r.json.contacts.length >= 5, "Une seule réponse : urgence, consignes, coordonnées, alertes, transports", `${Math.round(r.text.length / 1024)} Ko`);
check(!noticeCreatedByTest || /rendez-vous/.test(r.json.notice?.message), "… et l'avis d'incident");
check(r.json.contacts.some((g) => g.contacts.some((c) => c.id === shelterId && c.isOpen === false)), "Les coordonnées y sont à jour (abri complet)");
const etag = r.headers.get("etag");
check((await call("GET", "/api/public/essentials", { headers: { "if-none-match": etag } })).status === 304, "Rien de changé : 304");

section("6. LA PAGE DE SECOURS (SANS JAVASCRIPT, SERVIE PAR L'API)");
r = await call("GET", "/secours");
const csp = r.headers.get("content-security-policy");
check(r.status === 200 && /text\/html/.test(r.headers.get("content-type")) && !/script-src/.test(csp) && /default-src 'none'/.test(csp), "Page HTML autonome ; aucun script autorisé", csp);
check(!/<script/i.test(r.text) && r.text.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !r.text.includes("<img src=x"), "Texte piégé affiché sans être exécuté (échappé)");
check(r.text.includes('href="tel:112"') && r.text.includes("Urgence vitale : appelez le 112"), "Bouton d'appel d'urgence en tête");
check(r.text.includes("Cellule de crise municipale") && r.text.includes('href="tel:3100"') && r.text.includes("Complet : rejoignez l&#39;Abri du Dôme Sud"), "Coordonnées utiles cliquables, état des abris compris");
check((r.text.match(/<details/g) ?? []).length >= 11 && r.text.includes("Que faire en cas de"), "Toutes les consignes, dépliables sans script");
check(!noticeCreatedByTest || r.text.includes("les rendez-vous et les demandes en ligne sont indisponibles"), "L'avis d'incident est affiché");
check(r.text.length < 60_000, "Légère (réseau faible)", `${Math.round(r.text.length / 1024)} Ko`);
const en = await call("GET", "/secours?lang=en");
check(en.text.includes("Essential information") && en.text.includes('lang="en"'), "Version anglaise (?lang=en)");
check((await call("GET", "/api/public/secours")).status === 200, "Aussi sous /api/public/secours (derrière un proxy qui ne sert que /api)");
await sleep(500); // laisser les copies de secours s'écrire

section("7. PANNE DE LA BASE : TOUT CELA RESTE CONSULTABLE");
const OUT = await startOutage(1, {});
r = await call("GET", "/api/status", { base: OUT });
check(r.json?.status === "degraded" && r.json.features.find((f) => f.key === "contacts").mode === "last_known" && r.json.features.find((f) => f.key === "guide").mode === "live", "Panne détectée ; consignes à jour, coordonnées en dernière version connue", r.json?.features?.map((f) => `${f.key}:${f.mode}`).join(" "));
check(!noticeCreatedByTest || r.json.notice?.message?.includes("rendez-vous"), "L'avis d'incident reste lisible (fichier, pas base)");
r = await call("GET", "/secours", { base: OUT });
check(r.status === 200 && r.text.includes("dernières informations connues") && r.text.includes("Cellule de crise municipale") && r.text.includes('href="tel:112"'), "Page de secours servie pendant la panne, avec la date des informations");
check(/<details open><summary><strong>Panne de réseau ou de la plateforme/.test(r.text), "Les consignes « panne » sont dépliées d'office");
r = await call("GET", "/api/public/contacts?zone=south", { base: OUT });
check(r.status === 200 && r.json.stale === true && r.json.categories.length > 0, "Coordonnées utiles : dernière version connue", `savedAt ${r.json?.savedAt}`);
check((await call("GET", "/api/public/guide", { base: OUT })).status === 200, "Guide des consignes : toujours là");
r = await call("GET", "/api/public/essentials", { base: OUT });
check(r.status === 200 && r.json.complete && r.json.stale && r.json.contacts.length > 0, "Kit essentiel complet (dernière version connue)");

section("8. PIRE CAS : BASE EN PANNE ET AUCUNE COPIE");
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tn-snap-"));
const BARE = await startOutage(2, { SNAPSHOT_DIR: empty, PLATFORM_NOTICE_FILE: path.join(empty, "notice.json") });
r = await call("GET", "/secours", { base: BARE });
check(r.status === 200 && r.text.includes('href="tel:112"') && r.text.includes("Que faire en cas de") && r.text.includes("ne sont pas disponibles pour le moment"), "Page de secours quand même : numéro d'urgence et consignes, absence d'infos expliquée");
r = await call("GET", "/api/public/essentials", { base: BARE });
check(r.status === 200 && r.json.complete === false && r.json.emergency.number === "112" && r.json.guide.entries.length >= 10, "Kit essentiel minimal : urgence et consignes");

section("9. FIN DE L'INCIDENT");
if (noticeCreatedByTest) {
  check((await call("DELETE", "/api/platform/notice", { token: AD.token })).status === 204, "L'administrateur retire l'avis");
  noticeCreatedByTest = false;
  check((await call("GET", "/api/status")).json.status === "ok", "Tout est revenu à la normale");
}
check((await call("DELETE", `/api/contacts/${shelterId}`, { token: AG.token })).status === 204 && (await call("DELETE", `/api/contacts/${xss.json.id}`, { token: AG.token })).status === 204, "Contacts de test supprimés");
fs.rmSync(empty, { recursive: true, force: true });

console.log(`\n══ BILAN : ${pass} vérifications réussies, ${fails.length} échec(s)`);
fails.forEach((f) => console.log("   ❌ " + f));
process.exit(fails.length ? 1 : 0);
