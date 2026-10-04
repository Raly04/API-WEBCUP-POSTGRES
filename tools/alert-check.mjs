// Vérification des alertes à la population, sur le scénario « montée inhabituelle de l'eau dans le quartier sud ».
//   1. Lancer l'API en local (jamais en production) : PORT=5000 npm run dev
//   2. node tools/alert-check.mjs 5000
// Le test du temps réel utilise socket.io-client du front (../client/node_modules).
// Crée des comptes « alr_*@example.com », des alertes et des signalements, et SUPPRIME tout ensuite. Code de sortie 1 en cas d'échec.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [port = "5000", apiArg, clientArg] = process.argv.slice(2);
const apiDir = path.resolve(apiArg ?? path.join(here, ".."));
const clientDir = path.resolve(clientArg ?? path.join(apiDir, "..", "client"));
const BASE = `http://localhost:${port}`;
const U = `${BASE}/api`;
const J = { "content-type": "application/json" };
let pass = 0; const fails = [];
const check = (ok, t, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${t}${d ? "  — " + d : ""}`); ok ? pass++ : fails.push(t); };
const section = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = (args) => execFileSync("npx", ["tsx", "tools/alert-check-db.ts", ...args], { cwd: apiDir, encoding: "utf8", shell: true });
process.on("exit", () => { try { db(["clean"]); } catch {} });

async function call(method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(U + url, { method, headers: { ...J, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}
const stamp = Date.now().toString(36);
async function register(label, role) {
  const t = (await call("GET", "/forms/token?form=register")).json;
  await sleep(t.minDelayMs + 100);
  const r = await call("POST", "/auth/register", { body: { email: `alr_${label}_${stamp}@example.com`.toLowerCase(), password: "password123", firstName: label, lastName: "Alerte", ...(role ? { role } : {}) }, headers: { "x-form-token": t.token } });
  if (r.status !== 201) throw new Error(`inscription ${label} : ${r.status} ${r.text}`);
  return { token: r.json.accessToken, id: r.json.user.id, email: `alr_${label}_${stamp}@example.com`.toLowerCase() };
}

const [AD, AG, SA, SUD, NORD] = await Promise.all([register("Admin"), register("Agent"), register("Libre", "agent"), register("Sud"), register("Nord")]);
db(["roles", AD.email, AG.email]);

// Un habitant sans compte, connecté au canal public (comme la page d'accueil)
const require = createRequire(path.join(clientDir, "package.json"));
const { io } = require("socket.io-client");
const socket = io(BASE, { transports: ["websocket"], reconnection: false });
await new Promise((resolve) => { socket.on("connect", resolve); setTimeout(resolve, 4000); });
const events = [];
for (const name of ["alert:published", "alert:updated", "alert:ended"]) socket.on(name, (payload) => events.push({ name, payload, at: Date.now() }));
const waitEvent = async (name, id) => { for (let i = 0; i < 40; i++) { const e = events.find((x) => x.name === name && x.payload.id === id); if (e) return e; await sleep(100); } return null; };

const FLOOD = {
  title: "Montée inhabituelle de l'eau",
  hazard: "flood",
  severity: "warning",
  zones: ["south"],
  message: "Le niveau de l'eau monte anormalement le long du canal sud. Les rues basses peuvent être inondées dans l'heure.",
  instructions: ["Montez à l'étage ou en hauteur", "Évitez les rues basses et le bord du canal", "Ne traversez jamais une zone inondée, même à pied", "Gardez votre téléphone chargé"],
};

section("1. LA BONNE PERSONNE EST PRÉVENUE TOUT DE SUITE");
check(socket.connected, "Un habitant sans compte est connecté au canal public", socket.connected ? "connecté" : "non connecté");
const before = (await call("GET", "/public/alerts?zone=south")).json;
check(before && before.active.length === 0, "Avant : aucune alerte en cours dans le quartier sud (lecture publique, sans compte)");
const t0 = Date.now();
let r = await call("POST", "/alerts", { token: AG.token, body: FLOOD });
const alert = r.json;
check(r.status === 201 && alert.id, "Un agent validé publie l'alerte « montée de l'eau, quartier sud »", `${r.status}`);
const pub = await waitEvent("alert:published", alert?.id);
check(!!pub, "L'alerte arrive IMMÉDIATEMENT chez l'habitant connecté, sans recharger", pub ? `${pub.at - t0} ms après la publication` : "rien reçu");
check(pub?.payload.zones.includes("south"), "Elle indique les quartiers concernés (le client n'affiche le bandeau qu'aux habitants du sud)", pub?.payload.zones.join(","));

section("2. COMPRÉHENSIBLE D'UN COUP D'ŒIL");
const sud = (await call("GET", "/public/alerts?zone=south")).json;
const a = sud.active[0];
check(a?.id === alert.id, "Visible pour le quartier sud");
check(a.headline.fr === "ALERTE : PROTÉGEZ-VOUS — Montée inhabituelle de l'eau · Quartier sud", "Une phrase-titre prête pour un bandeau", a.headline.fr);
check(a.color === "orange" && a.actionRequired === true && a.severityLabel.fr === "Alerte : protégez-vous", "Niveau de gravité en couleur et « action requise »", `${a.color}, actionRequired ${a.actionRequired}`);
check(a.instructions.length === 4 && a.instructions[0] === "Montez à l'étage ou en hauteur", "QUE FAIRE : des consignes courtes, dans l'ordre", a.instructions.join(" | "));
check(a.hazardLabel.fr === "Montée des eaux / inondation" && a.zoneLabels.fr[0] === "Quartier sud" && a.expiresAt, "Quel danger, où, jusqu'à quand", `${a.hazardLabel.fr} · ${a.zoneLabels.fr} · fin prévue ${a.expiresAt}`);
check(a.issuer.fr === "Services municipaux de Terra Nova" && !JSON.stringify(sud).includes(AG.email) && !JSON.stringify(sud).includes("Agent Alerte"), "Émetteur officiel affiché, aucune donnée personnelle de l'agent");
const nord = (await call("GET", "/public/alerts?zone=north")).json;
check(nord.active.every((x) => x.id !== alert.id), "PAS affichée au quartier nord (non concerné)");
check((await call("GET", "/public/alerts")).json.active.some((x) => x.id === alert.id), "Visible dans la liste complète des alertes en cours");
const hdr = await call("GET", "/public/alerts?zone=south");
check(hdr.headers.get("cache-control") === "no-cache", "Jamais servie périmée : le navigateur revalide à chaque affichage", hdr.headers.get("cache-control"));

section("3. QUI PEUT ALERTER LA POPULATION");
check((await call("POST", "/alerts", { body: FLOOD })).status === 401, "Sans compte : 401");
check((await call("POST", "/alerts", { token: SUD.token, body: FLOOD })).status === 403, "Un citoyen ne peut pas publier d'alerte (403)");
r = await call("POST", "/alerts", { token: SA.token, body: FLOOD });
check(r.status === 403 && r.json?.code === "agent_not_validated", "Un agent inscrit librement (non validé) ne peut pas alerter la population", `${r.status} ${r.json?.code}`);
for (const [body, what] of [
  [{ ...FLOOD, instructions: [] }, "une alerte « protégez-vous » sans consigne"],
  [{ ...FLOOD, zones: ["quartier-perdu"] }, "un quartier inconnu"],
  [{ ...FLOOD, zones: ["all", "south"] }, "« toute la ville » mélangé à un quartier"],
  [{ ...FLOOD, title: "Eau" }, "un titre trop court"],
  [{ ...FLOOD, instructions: ["x".repeat(200)] }, "une consigne trop longue (illisible sous stress)"],
]) {
  r = await call("POST", "/alerts", { token: AG.token, body });
  check(r.status === 400, `Refusé : ${what}`, `${r.status} ${r.json?.message ?? ""}`);
}

section("4. LA SITUATION ÉVOLUE");
const info = (await call("POST", "/alerts", { token: AD.token, body: { title: "Coupure d'eau programmée", hazard: "water_outage", severity: "info", zones: ["all"], message: "Coupure d'eau de 14 h à 16 h pour travaux sur le réseau." } })).json;
const order = (await call("GET", "/public/alerts?zone=south")).json.active.map((x) => x.severity);
check(order[0] === "warning" && order.includes("info"), "La plus grave en premier (alerte avant information)", order.join(" > "));
check((await call("GET", "/public/alerts?zone=north")).json.active.some((x) => x.id === info.id), "Une information « toute la ville » est aussi affichée au nord");
r = await call("POST", `/alerts/${alert.id}/updates`, { token: AG.token, body: { message: "L'eau atteint la rue des Serres : évacuez les rez-de-chaussée.", severity: "emergency", instructions: ["Quittez les rez-de-chaussée maintenant", "Rejoignez le gymnase du centre (point de rassemblement)", "Évitez le bord du canal"] } });
const up = await waitEvent("alert:updated", alert.id);
check(r.status === 200 && r.json.version === 2 && r.json.color === "red", "Passage en URGENCE : version 2, couleur rouge", `version ${r.json?.version}, ${r.json?.color}`);
check(up?.payload.version === 2 && up.payload.instructions[0] === "Quittez les rez-de-chaussée maintenant", "La mise à jour arrive en temps réel avec les nouvelles consignes (le client ré-affiche même une alerte fermée)");
check(r.json.updates[0].message.startsWith("L'eau atteint la rue des Serres"), "Dernière évolution en premier", r.json.updates[0].message);

section("5. INTÉGRATION AVEC LES SIGNALEMENTS");
r = await call("POST", "/signalements", { token: SUD.token, body: { type: "flood", location: "Rue des Serres", zone: "south" } });
check(r.status === 201 && r.json.activeAlerts?.[0]?.id === alert.id && r.json.activeAlerts[0].instructions[0] === "Quittez les rez-de-chaussée maintenant", "Un habitant qui signale une inondation au sud voit AUSSITÔT les consignes en vigueur", r.json.activeAlerts?.[0]?.headline?.fr);
await call("POST", "/signalements", { token: NORD.token, body: { type: "flood", location: "Canal sud, pont 2", zone: "south" } });
await call("POST", "/signalements", { token: NORD.token, body: { type: "fire", location: "Entrepôt nord A", zone: "north" } });
await call("POST", "/signalements", { token: SUD.token, body: { type: "fire", location: "Entrepôt nord B", zone: "north" } });
const sum = (await call("GET", "/signalements/summary", { token: AG.token })).json;
const hotSouth = sum.hotspots?.find((h) => h.zone === "south" && h.type === "flood");
const hotNorth = sum.hotspots?.find((h) => h.zone === "north" && h.type === "fire");
check(hotSouth?.count >= 2 && hotSouth.alertActive === true, "Point chaud « inondation, quartier sud » repéré, alerte déjà en cours", JSON.stringify(hotSouth));
check(hotNorth?.count >= 2 && hotNorth.alertActive === false, "Point chaud « incendie, quartier nord » SANS alerte : le personnel voit qu'il faut peut-être prévenir le quartier", JSON.stringify(hotNorth));
check((await call("GET", "/signalements?zone=south", { token: AG.token })).json.signalements.every((s) => s.zone === "south"), "Le personnel filtre les signalements par quartier");

section("6. AU BON MOMENT : ELLE DISPARAÎT QUAND ELLE N'EST PLUS UTILE");
db(["expire", String(info.id)]);
await call("POST", `/alerts/${alert.id}/updates`, { token: AG.token, body: { message: "Point de situation : équipes sur place." } }); // invalide le cache
check(!(await call("GET", "/public/alerts")).json.active.some((x) => x.id === info.id), "Une alerte expirée n'est plus affichée, sans action de personne");
r = await call("POST", `/alerts/${alert.id}/end`, { token: AG.token, body: { endMessage: "Le niveau de l'eau est redescendu. Vous pouvez regagner vos logements ; restez prudents près du canal." } });
const ended = await waitEvent("alert:ended", alert.id);
const after = (await call("GET", "/public/alerts?zone=south")).json;
check(r.status === 200 && ended, "Fin d'alerte publiée et diffusée en temps réel");
check(!after.active.some((x) => x.id === alert.id) && after.recentlyEnded[0]?.id === alert.id && after.recentlyEnded[0].headline.fr.startsWith("Fin d'alerte") && /redescendu/.test(after.recentlyEnded[0].endMessage), "Retirée des alertes en cours, montrée comme « fin d'alerte » avec le message de retour à la normale", after.recentlyEnded[0]?.endMessage);
check(after.recentlyEnded[0].actionRequired === false, "Plus d'action requise après la fin d'alerte");
check((await call("POST", `/alerts/${alert.id}/updates`, { token: AG.token, body: { message: "trop tard" } })).status === 409, "On ne met plus à jour une alerte terminée (409)");
check((await call("GET", `/public/alerts/${alert.id}`)).status === 200 && (await call("GET", "/public/alerts/999999")).status === 404, "Détail public d'une alerte (même terminée), 404 sinon");
check((await call("GET", "/public/alerts/zones")).json.length === 6, "Liste des quartiers pour le choix « mon quartier »");

socket.close();
console.log(`\n══ BILAN : ${pass} vérifications réussies, ${fails.length} échec(s)`);
fails.forEach((f) => console.log("   ❌ " + f));
process.exit(fails.length ? 1 : 0);
