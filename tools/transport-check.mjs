// Vérification de bout en bout : lignes de transport interrompues, horaires, et fonctionnement pendant une panne.
//   1. API locale (jamais en production) : PORT=5000 npm run dev
//   2. node tools/transport-check.mjs 5000
// La partie « panne » lance une SECONDE instance de l'API (port + 1) branchée sur une base injoignable : la vraie base
// n'est jamais arrêtée. Crée des comptes « alr_*@example.com », des interruptions, des alertes, et SUPPRIME tout ensuite.
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [port = "5000"] = process.argv.slice(2);
const outagePort = String(Number(port) + 1);
const BASE = `http://localhost:${port}`;
let pass = 0; const fails = [];
const check = (ok, t, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${t}${d ? "  — " + d : ""}`); ok ? pass++ : fails.push(t); };
const section = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = (args) => execFileSync("npx", ["tsx", "tools/alert-check-db.ts", ...args], { cwd: apiDir, encoding: "utf8", shell: true });
let outage = null;
process.on("exit", () => {
  if (outage) try { execFileSync("taskkill", ["/PID", String(outage.pid), "/T", "/F"], { stdio: "ignore" }); } catch { try { outage.kill(); } catch {} }
  try { db(["clean"]); } catch {}
});

async function call(method, url, { token, body, headers = {}, base = BASE } = {}) {
  const res = await fetch(base + "/api" + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}
const q = (s) => encodeURIComponent(s);
const stamp = Date.now().toString(36);
async function register(label, role) {
  const t = (await call("GET", "/forms/token?form=register")).json;
  await sleep(t.minDelayMs + 100);
  const email = `alr_${label}_${stamp}@example.com`.toLowerCase();
  const r = await call("POST", "/auth/register", { body: { email, password: "password123", firstName: label, lastName: "Transport", ...(role ? { role } : {}) }, headers: { "x-form-token": t.token } });
  if (r.status !== 201) throw new Error(`inscription ${label} : ${r.status} ${r.text}`);
  return { token: r.json.accessToken, email };
}

const [AD, AG, SA, HAB] = await Promise.all([register("Admin"), register("Agent"), register("Libre", "agent"), register("Hab")]);
db(["roles", AD.email, AG.email]);
// Les jetons portent les permissions chargées à la requête : rien à rafraîchir

const require = createRequire(path.join(apiDir, "..", "client", "package.json"));
const { io } = require("socket.io-client");
const socket = io(BASE, { transports: ["websocket"], reconnection: false });
await new Promise((resolve) => { socket.on("connect", resolve); setTimeout(resolve, 4000); });
const events = [];
for (const name of ["transport:updated", "alert:published", "alert:updated", "alert:ended"]) socket.on(name, (payload) => events.push({ name, payload }));
const waitEvent = async (pred) => { for (let i = 0; i < 40; i++) { const e = events.find(pred); if (e) return e; await sleep(100); } return null; };

section("1. HORAIRES ET INFOS, SANS COMPTE");
let r = await call("GET", "/public/transport");
check(r.status === 200 && r.json.lines.length === 6 && r.json.summary.normal === 6, "État du réseau : 6 lignes, trafic normal", JSON.stringify(r.json?.summary));
const b3 = r.json.lines.find((l) => l.code === "B3");
check(b3.info.days.fr === "Du lundi au samedi" && b3.info.first === "06:00" && b3.info.last === "21:00" && /dimanche/.test(b3.info.notes), "Infos pratiques lisibles : jours, premier et dernier départ, tarif", `${b3.info.days.fr}, ${b3.info.first}-${b3.info.last}, « ${b3.info.notes} »`);
r = await call("GET", `/public/transport/stops/${q("marche")}`);
check(r.status === 200 && r.json.stop === "Marché" && /Prochain départ : ligne S1/.test(r.json.advice), "Fiche d'arrêt (« marche » sans accent suffit) : la phrase utile en premier", r.json?.advice);
check(r.json.lines[0].directions.length === 2 && r.json.lines[0].directions.every((d) => d.departures.length === 3 && /^\d\d:\d\d$/.test(d.departures[0].time)), "Les 3 prochains passages dans chaque sens, sur le même écran", r.json.lines[0].directions.map((d) => `→ ${d.towards} : ${d.departures.map((x) => x.time).join(", ")}`).join(" | "));
r = await call("GET", "/public/transport/lines/t1");
check(r.status === 200 && r.json.timetable.directions[0].stops.length === 6 && r.json.nextFromTermini[0].departures.length === 3, "Grille horaire d'une ligne (temps de parcours depuis chaque terminus)", `T1 : ${r.json?.timetable?.travelMinutes} min de bout en bout`);
r = await call("GET", `/public/transport/journey?from=${q("Marché")}&to=${q("Université")}`);
check(r.status === 200 && r.json.options[0]?.departure && r.json.options[0]?.arrival && r.json.usual.affected === false, "Trajet A → B avec heure de départ et d'arrivée", `${r.json?.options?.[0]?.departure} → ${r.json?.options?.[0]?.arrival} : ${r.json?.options?.[0]?.summary?.fr}`);
r = await call("GET", `/public/transport/journey?from=${q("Marchée")}&to=${q("Université")}`);
check(r.status === 400 && r.json.code === "unknown_stop" && r.json.suggestions.includes("Marché"), "Arrêt mal tapé : suggestions", JSON.stringify(r.json?.suggestions));

section("2. PLUSIEURS LIGNES INTERROMPUES : L'AGENT DÉCLARE");
const DECL = {
  reason: "Panne d'alimentation électrique sur le réseau sud",
  expectedEndAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
  items: [
    { line: "S1", kind: "interrupted", fromStop: "Marché", toStop: "Dôme Sud", alternatives: [
      { kind: "replacement_bus", from: "Marché", to: "Dôme Sud", text: "Bus de remplacement toutes les 15 min entre Marché et Dôme Sud", extraMinutes: 10 },
      { kind: "line", line: "T2", text: "Pour Dôme Sud, prenez aussi le tram T2" },
    ] },
    { line: "T1", kind: "delayed", alternatives: [] },
    { line: "C1", kind: "interrupted" },
  ],
};
check((await call("POST", "/transport/disruptions", { token: HAB.token, body: DECL })).status === 403, "Un citoyen ne peut pas déclarer (403)");
r = await call("POST", "/transport/disruptions", { token: SA.token, body: DECL });
check(r.status === 403 && r.json.code === "agent_not_validated", "Un agent non validé non plus");
for (const [body, what, code = 400] of [
  [{ ...DECL, items: [{ line: "Z9", kind: "interrupted" }] }, "ligne inconnue"],
  [{ ...DECL, items: [{ line: "S1", kind: "interrupted", fromStop: "Marché", toStop: "Porte Est" }] }, "arrêt qui n'est pas sur la ligne"],
  [{ ...DECL, items: [{ line: "S1", kind: "interrupted", alternatives: [{ kind: "replacement_bus", from: "Hôpital", to: "Dôme Sud", text: "Bus" }] }] }, "bus de remplacement hors de la ligne"],
  [{ ...DECL, items: [{ line: "S1", kind: "interrupted" }, { line: "s1", kind: "delayed" }] }, "même ligne deux fois"],
  [{ ...DECL, reason: "x" }, "cause absente"],
]) {
  r = await call("POST", "/transport/disruptions", { token: AG.token, body });
  check(r.status === code, `Refusé : ${what}`, `${r.status} ${r.json?.message ?? ""}`);
}
r = await call("POST", "/transport/disruptions", { token: AG.token, body: DECL });
const created = r.json;
check(r.status === 201 && created.disruptions.length === 3, "3 lignes déclarées en une fois", `${r.status} ${r.json?.message ?? ""}`);
const alert = created?.alert;
check(alert?.hazard === "transport" && alert.severity === "watch" && alert.transport?.length === 3, "Une seule alerte « Transports perturbés » pour les 3 lignes", alert?.title);
check(alert?.zones.includes("south") && alert.zones.includes("west") && alert.zones.includes("east"), "Envoyée aux quartiers desservis par ces lignes", alert?.zones.join(","));
check(alert?.instructions[0] === "S1 : Bus de remplacement toutes les 15 min entre Marché et Dôme Sud" && /^T1 : circulation ralentie/.test(alert.instructions[1]) && /^C1 : prenez la ligne (T1|B3) \(Porte Ouest\)/.test(alert.instructions[2]) && /rubrique Transports/.test(alert.instructions.at(-1)), "Consignes écrites pour l'habitant (solution de l'agent, ou ligne voisine calculée)", alert?.instructions.join(" | "));
check(/Ligne S1 interrompue entre Marché et Dôme Sud/.test(alert?.message) && /Cause : Panne d'alimentation/.test(alert?.message), "Message : quelles lignes, où, pourquoi", alert?.message);
check(!!(await waitEvent((e) => e.name === "alert:published" && e.payload.id === alert?.id && e.payload.transport?.length === 3)) && !!(await waitEvent((e) => e.name === "transport:updated" && e.payload.lines.some((l) => l.code === "S1" && l.state === "interrupted"))), "Diffusé en temps réel : alerte + état des lignes");
check((await call("POST", "/transport/disruptions", { token: AG.token, body: { ...DECL, items: [{ line: "S1", kind: "delayed" }] } })).status === 409, "Ligne déjà déclarée : 409 (la modifier plutôt)");

section("3. L'HABITANT TROUVE UNE SOLUTION, SUR UN SEUL ÉCRAN");
r = await call("GET", "/public/transport");
check(r.json.summary.interrupted === 2 && r.json.summary.delayed === 1 && r.json.lines[0].state === "interrupted", "Les lignes touchées apparaissent en premier", JSON.stringify(r.json.summary));
const s1 = r.json.lines.find((l) => l.code === "S1");
check(JSON.stringify(s1.disruptions[0].unservedStops) === JSON.stringify(["Rue des Serres", "Canal Sud"]), "Arrêts non desservis indiqués", s1.disruptions[0].unservedStops.join(", "));
check(s1.disruptions[0].suggestedLines.some((l) => l.code === "T2"), "Lignes encore utilisables proposées automatiquement", s1.disruptions[0].suggestedLines.map((l) => `${l.code} (${l.servesStops.join(", ")})`).join(" ; "));
r = await call("GET", `/public/transport/stops/${q("Canal Sud")}`);
check(/La ligne S1 ne passe plus ici \(Panne d'alimentation électrique sur le réseau sud\) : bus de remplacement/.test(r.json.advice), "À l'arrêt Canal Sud : pourquoi et quoi faire, en une phrase", r.json.advice);
check(r.json.lines.find((l) => l.line.code === "S1").directions.every((d) => !d.served && d.departures.length === 0), "Aucun horaire trompeur pour une ligne qui ne passe plus");
r = await call("GET", `/public/transport/journey?from=${q("Rue des Serres")}&to=${q("Gare Centrale")}`);
check(r.json.usual.affected === true && /Ligne S1 interrompue/.test(r.json.usual.disruptions[0].headline.fr), "« Votre trajet habituel est coupé » : dit clairement", r.json.usual.disruptions[0]?.headline.fr);
check(r.json.options.length > 0 && r.json.options[0].usesReplacement && r.json.options[0].arrival, "Itinéraire de remplacement avec heures (bus de remplacement inclus)", `${r.json.options[0]?.departure} → ${r.json.options[0]?.arrival} : ${r.json.options[0]?.summary.fr}`);
r = await call("GET", `/public/transport/journey?from=${q("Porte Ouest")}&to=${q("Canal Sud")}`);
check(r.json.options.length > 0 && r.json.options.every((o) => o.legs.every((l) => l.line.code !== "C1")), "Téléphérique coupé : on passe par une autre ligne", r.json.options[0]?.summary.fr);
r = await call("GET", "/public/alerts?zone=south");
const pa = r.json.active.find((a) => a.id === alert.id);
check(pa && pa.transport.length === 3 && pa.transport[0].headline.fr, "L'alerte publique liste les lignes touchées (bouton « trouver un autre trajet »)", pa?.transport.map((t) => t.line.code).join(", "));

section("4. LA SITUATION ÉVOLUE, PUIS SE RÉTABLIT");
const [dS1, dT1, dC1] = created.disruptions;
r = await call("PATCH", `/transport/disruptions/${dS1.id}`, { token: AG.token, body: { fromStop: "Canal Sud", toStop: "Dôme Sud" } });
check(r.status === 200 && r.json.section.from === "Canal Sud" && r.json.unservedStops.length === 0, "Section réduite : Rue des Serres de nouveau desservie", JSON.stringify(r.json?.section));
check(!!(await waitEvent((e) => e.name === "alert:updated" && e.payload.id === alert.id)), "L'alerte se met à jour d'elle-même");
check((await call("POST", `/transport/disruptions/${dC1.id}/end`, { token: AG.token })).json?.alert?.status === "active", "C1 rétablie : l'alerte reste (S1 et T1 encore touchées)");
await call("POST", `/transport/disruptions/${dT1.id}/end`, { token: AG.token });
r = await call("POST", `/transport/disruptions/${dS1.id}/end`, { token: AG.token });
check(r.json?.alert?.status === "ended" && /Trafic rétabli sur les lignes S1, T1, C1/.test(r.json.alert.endMessage), "Dernière ligne rétablie : fin d'alerte automatique", r.json?.alert?.endMessage);
check(!!(await waitEvent((e) => e.name === "alert:ended" && e.payload.id === alert.id)), "Fin d'alerte diffusée en temps réel");
check((await call("GET", "/public/transport")).json.summary.normal === 6, "Réseau revenu à la normale");
check((await call("POST", `/transport/disruptions/${dS1.id}/end`, { token: AG.token })).status === 409, "Déjà terminée : 409");

section("5. PANNE DE RÉSEAU : CE QUI RESTE RÉCUPÉRABLE");
// Une perturbation en cours pendant la panne, pour vérifier qu'elle reste visible
r = await call("POST", "/transport/disruptions", { token: AG.token, body: { reason: "Travaux de voirie", items: [{ line: "N1", kind: "interrupted", fromStop: "Serres Nord", toStop: "Gare Centrale", alternatives: [{ kind: "line", line: "T1", text: "Prenez le tram T1 à Place des Pionniers" }] }] } });
const outageAlertId = r.json?.alert?.id;
r = await call("GET", "/public/essentials");
const etag = r.headers.get("etag");
check(r.status === 200 && r.json.emergency.number && r.json.offlineGuide.fr.length >= 4, "Kit essentiel : numéro d'urgence et conduite à tenir hors ligne", r.json?.emergency?.label?.fr);
check(r.json.alerts.some((a) => a.id === outageAlertId) && r.json.transport.lines.find((l) => l.code === "N1").state === "interrupted" && r.json.services.length > 0, "… alertes en cours, état des lignes, services municipaux");
check(r.json.transport.lines.every((l) => l.terminusDepartures.length > 10 && l.minutesBetweenStops), "… et les horaires bruts, pour calculer les prochains passages sans réseau", `${r.json.transport.lines[0].terminusDepartures.length} départs/jour pour ${r.json.transport.lines[0].code}`);
check(r.text.length < 60_000, "Compact (à garder sur le téléphone)", `${Math.round(r.text.length / 1024)} Ko`);
check((await call("GET", "/public/essentials", { headers: { "if-none-match": etag } })).status === 304, "Rien de changé : 304, rien à retélécharger", etag);
r = await call("GET", "/status");
check(r.json.status === "ok" && r.json.features.every((f) => f.key === "ai" || f.available), "État du service : tout fonctionne", r.json.message.fr);
await call("GET", "/public/alerts"); await call("GET", "/public/transport"); await call("GET", `/public/transport/stops/${q("Place des Pionniers")}`);
await sleep(500); // laisser les copies de secours s'écrire

// Seconde instance de l'API, base injoignable (comme si MySQL ou le réseau interne était tombé), mêmes copies de secours
outage = spawn("npx", ["tsx", "src/index.ts"], { cwd: apiDir, shell: true, env: { ...process.env, PORT: outagePort, DB_PORT: "1", SEED_ON_START: "false", LOG_REQUESTS: "errors", DB_READ_TIMEOUT_MS: "1500" }, stdio: "ignore" });
const OUT = `http://localhost:${outagePort}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(OUT + "/api/health")).ok) break; } catch {} await sleep(500); }
r = await call("GET", "/status", { base: OUT });
check(r.json?.status === "degraded" && r.json.database === "down", "Panne détectée : « mode dégradé » expliqué en clair", r.json?.message?.fr);
check(r.json?.features.find((f) => f.key === "alerts").mode === "last_known" && r.json.features.find((f) => f.key === "signalements").mode === "queued", "Ce qui marche encore (alertes, horaires) et ce qui attend (signalements)", r.json?.features.map((f) => `${f.key}:${f.mode}`).join(" "));
r = await call("GET", "/public/alerts", { base: OUT });
check(r.status === 200 && r.json.stale === true && r.json.active.some((a) => a.id === outageAlertId) && r.headers.get("x-data-stale") === "1", "Alertes toujours lisibles (dernière version connue, datée)", `savedAt ${r.json?.savedAt}`);
r = await call("GET", "/public/transport", { base: OUT });
check(r.status === 200 && r.json.stale && r.json.lines.find((l) => l.code === "N1").state === "interrupted", "État des transports toujours lisible, perturbation comprise");
r = await call("GET", `/public/transport/stops/${q("Place des Pionniers")}`, { base: OUT });
check(r.status === 200 && /N1 ne passe plus ici/.test(r.json.advice) && r.json.lines.some((l) => l.directions.some((d) => d.departures.length)), "Fiche d'arrêt et prochains passages calculés pendant la panne", r.json?.advice);
r = await call("GET", `/public/transport/journey?from=${q("Serres Nord")}&to=${q("Gare Centrale")}`, { base: OUT });
check(r.status === 200 && r.json.options.length > 0, "Itinéraire de remplacement calculé pendant la panne", r.json?.options?.[0]?.summary?.fr);
r = await call("GET", "/public/essentials", { base: OUT });
check(r.status === 200 && r.json.stale === true && r.json.complete === true && r.json.emergency.number, "Kit essentiel servi pendant la panne");
r = await call("POST", "/signalements", { base: OUT, token: HAB.token, body: { type: "breakdown", location: "Dôme Nord" } });
check(r.status === 503 && /réessayez/i.test(r.json?.message ?? "") && r.headers.get("retry-after"), "Signaler pendant la panne : refus clair et temporaire (le client garde le signalement)", `${r.status} ${r.json?.message}`);

section("6. SIGNALEMENT GARDÉ HORS LIGNE, ENVOYÉ AU RETOUR DU RÉSEAU");
const ref = `off-${stamp}-abc123`;
const reportedAt = new Date(Date.now() - 20 * 60_000).toISOString();
r = await call("POST", "/signalements", { token: HAB.token, body: { type: "breakdown", location: "Dôme Nord, entrée B", clientRef: ref, reportedAt } });
check(r.status === 201 && r.json.reportedAt && Math.abs(new Date(r.json.reportedAt) - new Date(reportedAt)) < 2000, "Envoyé au retour du réseau, avec l'heure réelle du constat", `constaté ${r.json?.reportedAt}, reçu ${r.json?.createdAt}`);
const again = await call("POST", "/signalements", { token: HAB.token, body: { type: "breakdown", location: "Dôme Nord, entrée B (renvoi)", clientRef: ref, reportedAt } });
check(again.status === 200 && again.json.duplicate === true && again.json.id === r.json.id, "Renvoyé deux fois (réseau instable) : un seul signalement", `id ${again.json?.id}`);
check((await call("POST", "/signalements", { token: HAB.token, body: { type: "breakdown", location: "X Y", clientRef: "a b" } })).status === 400, "clientRef invalide : 400");
check((await call("POST", "/signalements", { token: HAB.token, body: { type: "breakdown", location: "X Y", reportedAt: new Date(Date.now() - 3 * 86400_000).toISOString() } })).status === 400, "Constat de plus de 24 h : 400");

socket.close();
console.log(`\n══ BILAN : ${pass} vérifications réussies, ${fails.length} échec(s)`);
fails.forEach((f) => console.log("   ❌ " + f));
process.exit(fails.length ? 1 : 0);
