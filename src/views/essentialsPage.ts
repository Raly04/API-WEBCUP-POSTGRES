import { TIMEZONE } from "../utils/transport/schedule";

// Page de secours : HTML autonome, sans JavaScript ni ressource externe, ~30 Ko. Tout ce qu'une personne doit pouvoir
// consulter quand la plateforme est en difficulté : le numéro d'urgence, l'état des services, les alertes et leurs
// consignes, les coordonnées utiles, les transports, le guide « que faire en cas de... ». Tout texte venant de la base
// est échappé : la page n'exécute rien.

type Lang = "fr" | "en";
type Text = { fr: string; en: string };
type Lines = { fr: string[]; en: string[] };

interface PageInput {
  lang: Lang;
  data: any | null; // kit essentiel (partie base), ou null si indisponible
  stale: boolean;
  savedAt: Date | string | null;
  status: { status: string; message: Text; details: Text | null; notice: { severity: string; since: string } | null; features: { key: string; label: Text; available: boolean; mode: string }[] };
  guide: { entries: { key: string; title: Text; summary: Text; before: Lines; during: Lines; after: Lines }[]; kit: Lines };
  emergency: { number: string; href: string; label: Text; note: Text };
  offlineGuide: Lines;
}

const T = {
  fr: {
    title: "Terra Nova — Informations essentielles",
    lead: "Page de secours : légère, sans compte, lisible hors connexion une fois enregistrée.",
    updated: "Informations mises à jour le",
    staleNote: "Connexion à nos serveurs perdue : voici les dernières informations connues.",
    missing: "Les informations détaillées (alertes, coordonnées, transports) ne sont pas disponibles pour le moment. Le numéro d'urgence et les consignes ci-dessous restent valables.",
    nav: ["Alertes", "Coordonnées", "Transports", "Que faire ?", "Sac d'urgence"],
    status: "État des services",
    works: "Disponible",
    lastKnown: "Dernières infos connues",
    queued: "Envoi différé",
    down: "Indisponible",
    alerts: "Alertes en cours",
    noAlert: "Aucune alerte en cours.",
    whatToDo: "Que faire",
    until: "Jusqu'à",
    zones: "Où",
    contacts: "Coordonnées utiles",
    open: "Ouvert",
    closed: "Fermé",
    h24: "24 h/24",
    transport: "Transports",
    service: "Service",
    every: "toutes les",
    guide: "Que faire en cas de…",
    before: "Avant",
    during: "Pendant",
    after: "Après",
    kit: "Sac d'urgence",
    offline: "Sans connexion",
    footer: "Enregistrez cette page (menu du navigateur › Enregistrer ou Ajouter à l'écran d'accueil) ou imprimez-la pour l'avoir sous la main.",
    other: "English version",
  },
  en: {
    title: "Terra Nova — Essential information",
    lead: "Emergency page: lightweight, no account needed, readable offline once saved.",
    updated: "Information updated on",
    staleNote: "Connection to our servers lost: here is the latest known information.",
    missing: "Detailed information (alerts, contacts, transport) is not available right now. The emergency number and guidance below remain valid.",
    nav: ["Alerts", "Contacts", "Transport", "What to do", "Emergency bag"],
    status: "Service status",
    works: "Available",
    lastKnown: "Latest known info",
    queued: "Sent later",
    down: "Unavailable",
    alerts: "Current alerts",
    noAlert: "No current alert.",
    whatToDo: "What to do",
    until: "Until",
    zones: "Where",
    contacts: "Useful contacts",
    open: "Open",
    closed: "Closed",
    h24: "24/7",
    transport: "Transport",
    service: "Service",
    every: "every",
    guide: "What to do in case of…",
    before: "Before",
    during: "During",
    after: "After",
    kit: "Emergency bag",
    offline: "Without connection",
    footer: "Save this page (browser menu › Save or Add to home screen) or print it to keep it at hand.",
    other: "Version française",
  },
};

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const safeColor = (value: unknown) => (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#64748b");
const safeTel = (value: unknown) => {
  const digits = String(value ?? "").replace(/[^\d+]/g, "");
  return digits ? `tel:${digits}` : null;
};
const safeMail = (value: unknown) => (typeof value === "string" && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(value) ? `mailto:${value}` : null);

function when(value: Date | string | null | undefined, lang: Lang) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "fr-FR", { timeZone: TIMEZONE, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(date);
}

const list = (items: string[], ordered = false) =>
  items.length ? `<${ordered ? "ol" : "ul"}>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</${ordered ? "ol" : "ul"}>` : "";

const SEVERITY_COLORS: Record<string, string> = { blue: "#2563eb", yellow: "#ca8a04", orange: "#ea580c", red: "#dc2626" };

function alertsSection(data: any, lang: Lang, t: (typeof T)[Lang]) {
  const alerts: any[] = data?.alerts ?? [];
  const body = alerts.length
    ? alerts
        .map((alert) => {
          const latest = alert.updates?.[0];
          return `<article class="alert" style="border-color:${SEVERITY_COLORS[alert.color] ?? "#64748b"}">
  <p class="sev" style="color:${SEVERITY_COLORS[alert.color] ?? "inherit"}">${esc(alert.severityLabel?.[lang])}</p>
  <h3>${esc(alert.headline?.[lang])}</h3>
  <p class="meta">${esc(t.zones)} : ${esc((alert.zoneLabels?.[lang] ?? []).join(", "))}${alert.expiresAt ? ` · ${esc(t.until)} ${esc(when(alert.expiresAt, lang))}` : ""}</p>
  <p>${esc(alert.message)}</p>
  ${latest && latest.message !== alert.message ? `<p class="update">${esc(when(latest.at, lang))} — ${esc(latest.message)}</p>` : ""}
  ${alert.instructions?.length ? `<p class="todo">${esc(t.whatToDo)}</p>${list(alert.instructions, true)}` : ""}
</article>`;
        })
        .join("\n")
    : `<p class="muted">${esc(t.noAlert)}</p>`;
  return `<section id="alertes"><h2>${esc(t.alerts)}</h2>${body}</section>`;
}

function contactsSection(data: any, lang: Lang, t: (typeof T)[Lang]) {
  const groups: any[] = data?.contacts ?? [];
  if (!groups.length) return "";
  const PLACES = new Set(["shelter", "water", "health"]);
  return `<section id="coordonnees"><h2>${esc(t.contacts)}</h2>${groups
    .map(
      (group) => `<h3>${esc(group.label?.[lang])}</h3><ul class="contacts">${group.contacts
        .map((contact: any) => {
          const tel = safeTel(contact.phone);
          const mail = safeMail(contact.email);
          const state = PLACES.has(group.category) && contact.address
            ? `<span class="chip ${contact.isOpen ? "ok" : "ko"}">${esc(contact.isOpen ? t.open : t.closed)}</span>`
            : "";
          return `<li><p><strong>${esc(contact.label)}</strong> ${state}${contact.zoneLabel ? ` <span class="muted">· ${esc(contact.zoneLabel[lang])}</span>` : ""}</p>
  ${contact.statusNote ? `<p class="note">${esc(contact.statusNote)}</p>` : ""}
  ${tel ? `<p><a class="tel" href="${esc(tel)}">${esc(contact.phone)}</a>${contact.available24h ? ` <span class="muted">${esc(t.h24)}</span>` : ""}</p>` : ""}
  ${mail ? `<p><a href="${esc(mail)}">${esc(contact.email)}</a></p>` : ""}
  ${contact.address ? `<p>${esc(contact.address)}</p>` : ""}
  ${contact.openingHours ? `<p class="muted">${esc(contact.openingHours)}</p>` : ""}
  ${contact.description ? `<p class="muted">${esc(contact.description)}</p>` : ""}</li>`;
        })
        .join("")}</ul>`
    )
    .join("")}</section>`;
}

function transportSection(data: any, lang: Lang, t: (typeof T)[Lang]) {
  const lines: any[] = data?.transport?.lines ?? [];
  if (!lines.length) return "";
  const order: Record<string, number> = { interrupted: 0, delayed: 1, normal: 2 };
  return `<section id="transports"><h2>${esc(t.transport)}</h2><ul class="lines">${[...lines]
    .sort((a, b) => (order[a.state] ?? 3) - (order[b.state] ?? 3))
    .map(
      (line) => `<li><p><span class="line" style="background:${safeColor(line.color)}">${esc(line.code)}</span> <strong>${esc(line.name)}</strong> — <span class="state ${esc(line.state)}">${esc(line.stateLabel?.[lang])}</span></p>
  ${(line.disruptions ?? [])
    .map((d: any) => `<p class="note">${esc(d.headline?.[lang])} (${esc(d.reason)})</p>${list(d.alternatives ?? [])}`)
    .join("")}
  <p class="muted">${esc(line.info?.days?.[lang] ?? "")} · ${esc(line.info?.first ?? "")}–${esc(line.info?.last ?? "")}${line.info?.frequencyMinutes ? ` · ${esc(t.every)} ${esc(line.info.frequencyMinutes)} min` : ""}</p></li>`
    )
    .join("")}</ul></section>`;
}

function guideSection(input: PageInput, lang: Lang, t: (typeof T)[Lang]) {
  const activeHazards = new Set<string>((input.data?.alerts ?? []).map((alert: any) => alert.hazard));
  if (input.status.status !== "ok") activeHazards.add("network");
  return `<section id="consignes"><h2>${esc(t.guide)}</h2>${input.guide.entries
    .map(
      (entry) => `<details${activeHazards.has(entry.key) ? " open" : ""}><summary><strong>${esc(entry.title[lang])}</strong> — ${esc(entry.summary[lang])}</summary>
  ${entry.before[lang].length ? `<h4>${esc(t.before)}</h4>${list(entry.before[lang])}` : ""}
  ${entry.during[lang].length ? `<h4>${esc(t.during)}</h4>${list(entry.during[lang])}` : ""}
  ${entry.after[lang].length ? `<h4>${esc(t.after)}</h4>${list(entry.after[lang])}` : ""}
</details>`
    )
    .join("\n")}</section>
<section id="sac"><h2>${esc(t.kit)}</h2>${list(input.guide.kit[lang])}<h3>${esc(t.offline)}</h3>${list(input.offlineGuide[lang])}</section>`;
}

function statusSection(input: PageInput, lang: Lang, t: (typeof T)[Lang]) {
  const { status } = input;
  const modeLabel = (mode: string) => (mode === "live" ? t.works : mode === "last_known" ? t.lastKnown : mode === "queued" ? t.queued : t.down);
  const banner = status.status === "ok" ? "" : `<div class="banner ${status.status}"><p>${esc(status.message[lang])}</p>${status.details ? `<p>${esc(status.details[lang])}</p>` : ""}</div>`;
  return `${banner}<details class="status"${status.status === "ok" ? "" : " open"}><summary>${esc(t.status)}</summary><ul>${status.features
    .map((feature) => `<li><span class="dot ${feature.available ? "ok" : feature.mode === "queued" ? "wait" : "ko"}"></span>${esc(feature.label[lang])} : ${esc(modeLabel(feature.mode))}</li>`)
    .join("")}</ul></details>`;
}

export function renderEssentialsPage(input: PageInput): string {
  const { lang, data, emergency } = input;
  const t = T[lang];
  const updated = input.savedAt ? `<p class="muted">${esc(t.updated)} ${esc(when(input.savedAt, lang))}</p>` : "";
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(t.title)}</title>
<style>
:root{--bg:#f8fafc;--card:#fff;--text:#0f172a;--muted:#475569;--line:#e2e8f0;--accent:#b91c1c;--ok:#15803d;--ko:#b91c1c;--wait:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#111827;--text:#e5e7eb;--muted:#9ca3af;--line:#1f2937;--accent:#f87171;--ok:#4ade80;--ko:#f87171;--wait:#fbbf24}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}h1{font-size:1.4rem;margin:.2rem 0}h2{font-size:1.2rem;margin:1.6rem 0 .6rem;border-bottom:2px solid var(--line);padding-bottom:.2rem}
h3{font-size:1.05rem;margin:1rem 0 .3rem}h4{margin:.6rem 0 .2rem;font-size:.95rem}p{margin:.25rem 0}ul,ol{margin:.3rem 0 .3rem 1.2rem;padding:0}li{margin:.15rem 0}
a{color:inherit}.muted{color:var(--muted)}.note{font-weight:600}
.call{display:block;text-align:center;background:var(--accent);color:#fff;text-decoration:none;font-size:1.35rem;font-weight:700;padding:14px;border-radius:12px;margin:12px 0 4px}
nav{display:flex;flex-wrap:wrap;gap:6px 14px;margin:10px 0;font-size:.95rem}
.banner{border-radius:10px;padding:10px 12px;margin:10px 0;border:2px solid var(--wait);background:var(--card)}.banner.degraded{border-color:var(--ko)}
.status{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:8px 0}.status ul{list-style:none;margin:.4rem 0 0}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;background:var(--ok)}.dot.ko{background:var(--ko)}.dot.wait{background:var(--wait)}
.alert{background:var(--card);border:1px solid var(--line);border-left:6px solid;border-radius:10px;padding:10px 12px;margin:10px 0}
.sev{font-weight:700;text-transform:uppercase;font-size:.85rem}.meta{color:var(--muted);font-size:.9rem}.todo{font-weight:700;margin-top:.5rem}.update{font-style:italic}
.contacts,.lines{list-style:none;margin:0}.contacts li,.lines li{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:8px 0}
.tel{font-size:1.15rem;font-weight:700}.chip{font-size:.8rem;font-weight:700;padding:1px 8px;border-radius:999px;border:1px solid}.chip.ok{color:var(--ok)}.chip.ko{color:var(--ko)}
.line{display:inline-block;min-width:2.4rem;text-align:center;color:#fff;font-weight:700;border-radius:6px;padding:0 6px}.state.interrupted{color:var(--ko);font-weight:700}.state.delayed{color:var(--wait);font-weight:700}
details{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:8px 0}summary{cursor:pointer}
footer{margin:2rem 0 1rem;font-size:.9rem;color:var(--muted)}
@media print{nav,.lang{display:none}details{break-inside:avoid}details:not([open])>*:not(summary){display:block}.call{border:2px solid #000;color:#000;background:none}}
</style>
</head>
<body>
<main>
<header>
<p class="lang"><a href="?lang=${lang === "fr" ? "en" : "fr"}">${esc(t.other)}</a></p>
<h1>${esc(t.title)}</h1>
<p class="muted">${esc(t.lead)}</p>
${updated}
${input.stale && data ? `<p class="note">${esc(t.staleNote)}</p>` : ""}
</header>
<a class="call" href="${esc(emergency.href)}">${esc(emergency.label[lang])}</a>
<p class="muted">${esc(emergency.note[lang])}</p>
${statusSection(input, lang, t)}
<nav><a href="#alertes">${esc(t.nav[0])}</a><a href="#coordonnees">${esc(t.nav[1])}</a><a href="#transports">${esc(t.nav[2])}</a><a href="#consignes">${esc(t.nav[3])}</a><a href="#sac">${esc(t.nav[4])}</a></nav>
${data ? "" : `<p class="banner">${esc(t.missing)}</p>`}
${data ? alertsSection(data, lang, t) : ""}
${data ? contactsSection(data, lang, t) : ""}
${data ? transportSection(data, lang, t) : ""}
${guideSection(input, lang, t)}
<footer><p>${esc(t.footer)}</p></footer>
</main>
</body>
</html>`;
}
