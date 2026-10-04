import crypto from "node:crypto";
import { Request, Response } from "express";
import { EMERGENCY_NUMBER } from "../config/emergency";
import { GUIDE_KEYS, safetyGuide } from "../content/safetyGuide";
import { AlertModel } from "../models/alert.model";
import { MunicipalServiceModel } from "../models/municipalService.model";
import { TransportModel } from "../models/transport.model";
import { UsefulContactModel } from "../models/usefulContact.model";
import { aiApiKey } from "../utils/ai/llm";
import { audit } from "../utils/audit";
import { NOTICE_FEATURES, clearNotice, readNotice, writeNotice, type NoticeFeature, type PlatformNotice } from "../utils/platformNotice";
import { databaseState, probeDatabase, resilientCached, snapshotDate } from "../utils/resilience";
import { withTransport } from "../utils/transport/alertLink";
import { terminusDepartures, toClock } from "../utils/transport/schedule";
import { publicAlertView } from "../views/alert.view";
import { renderEssentialsPage } from "../views/essentialsPage";
import { disruptionView, lineInfo, lineView } from "../views/transport.view";
import { groupedContactsView } from "../views/usefulContact.view";

// Lorsqu'un incident touche la plateforme, l'habitant n'a pas besoin de tout faire : il doit au moins pouvoir consulter
// les informations essentielles, les consignes et les coordonnées utiles. Tout ce qui suit sert ce besoin :
//   - un kit essentiel (JSON) que le site garde sur l'appareil et relit hors ligne ;
//   - une page de secours (HTML sans JavaScript), servie par l'API même si le site principal est en panne ;
//   - l'état des services et l'avis d'incident, pour savoir ce qui marche encore sans tout essayer ;
//   - le guide des consignes, écrit dans le code : disponible même si la base de données est tombée.

// Ne dépend d'aucune base : toujours disponible, même au pire de la panne
const GUIDE = safetyGuide(EMERGENCY_NUMBER);
const STATIC_ESSENTIALS = {
  emergency: {
    number: EMERGENCY_NUMBER,
    href: `tel:${EMERGENCY_NUMBER.replace(/[^\d+]/g, "")}`,
    label: { fr: `Urgence vitale : appelez le ${EMERGENCY_NUMBER}`, en: `Life-threatening emergency: call ${EMERGENCY_NUMBER}` },
    note: { fr: "Un appel d'urgence passe même sans internet.", en: "Emergency calls work without internet." },
  },
  offlineGuide: {
    fr: [
      `En cas d'urgence vitale, appelez le ${EMERGENCY_NUMBER} : pas besoin d'internet.`,
      "Les alertes et horaires affichés sont ceux de la dernière mise à jour (l'heure est indiquée).",
      "Un signalement envoyé sans réseau est gardé sur votre appareil et part automatiquement au retour de la connexion.",
      "Suivez les consignes des alertes en cours, même si elles ne se mettent plus à jour.",
      "Les horaires de transport restent consultables ; en cas de doute, rendez-vous à l'arrêt et suivez l'affichage sur place.",
    ],
    en: [
      `For a life-threatening emergency, call ${EMERGENCY_NUMBER}: no internet needed.`,
      "Alerts and timetables shown are from the last update (time shown).",
      "A report sent without network is kept on your device and sent automatically when the connection returns.",
      "Follow the instructions of current alerts, even if they no longer update.",
      "Timetables remain available; if in doubt, go to the stop and follow the local display.",
    ],
  },
  guide: GUIDE,
};

async function loadEssentials() {
  const [alerts, lines, active, services, contacts] = await Promise.all([
    AlertModel.listActive(undefined, 2),
    TransportModel.listLines(),
    TransportModel.listActiveDisruptions(),
    MunicipalServiceModel.list({ includeInactive: false }),
    UsefulContactModel.listPublic(),
  ]);
  const data = {
    alerts: await withTransport(alerts.map(publicAlertView)),
    contacts: groupedContactsView(contacts),
    transport: {
      lines: lines.map((line) => {
        const view = lineView(line, lines, active);
        return {
          code: line.code,
          name: line.name,
          mode: line.mode,
          color: line.color,
          state: view.state,
          stateLabel: view.stateLabel,
          stops: line.stops,
          info: lineInfo(line),
          // De quoi calculer les prochains passages SANS réseau : départ du terminus + n × minutesBetweenStops
          minutesBetweenStops: line.minutesBetweenStops,
          serviceDays: line.schedule?.days ?? [],
          terminusDepartures: terminusDepartures(line).map(toClock),
          disruptions: active
            .filter((d) => d.line.code === line.code)
            .map((d) => {
              const full = disruptionView(d, lines, active);
              return { headline: full.headline, reason: full.reason, unservedStops: full.unservedStops, alternatives: full.alternatives.map((a) => a.text), expectedEndAt: full.expectedEndAt };
            }),
        };
      }),
    },
    services: services.map((service) => ({ code: service.code, name: service.name, description: service.description, icon: service.icon })),
  };
  // Empreinte du contenu : le client ne retélécharge que si quelque chose a changé (ETag / If-None-Match)
  return { ...data, version: crypto.createHash("sha1").update(JSON.stringify(data)).digest("hex").slice(0, 16) };
}

type EssentialsData = Awaited<ReturnType<typeof loadEssentials>>;

// Partie « base de données » : à jour, sinon dernière version connue, sinon rien (la partie statique reste servie)
async function essentialsData(): Promise<{ data: EssentialsData | null; stale: boolean; savedAt: Date | null }> {
  try {
    const result = await resilientCached("essentials", 10_000, loadEssentials, { persist: true });
    return { data: result.data, stale: result.stale, savedAt: result.savedAt };
  } catch {
    return { data: null, stale: true, savedAt: null };
  }
}

// À appeler au démarrage : une copie de secours existe ainsi avant même la première visite
export async function primeEssentials() {
  await essentialsData();
}

// GET /api/public/essentials
export async function getEssentials(req: Request, res: Response) {
  const { data, stale, savedAt } = await essentialsData();
  const notice = readNotice();
  const body = data
    ? { ...STATIC_ESSENTIALS, notice, ...data, stale, savedAt, complete: true }
    : { ...STATIC_ESSENTIALS, notice, alerts: null, contacts: null, transport: null, services: null, version: "static", stale: true, savedAt: null, complete: false };
  const etag = `"${body.version}-${stale ? 1 : 0}-${notice?.updatedAt ?? "0"}"`;
  res.set("ETag", etag);
  res.set("Cache-Control", "no-cache");
  if (req.headers["if-none-match"] === etag) return res.status(304).end();
  res.json(body);
}

// ── Consignes ─────────────────────────────────────────────────────────────────────────────

// GET /api/public/guide -> « Que faire en cas de... » + sac d'urgence. Ne touche pas la base.
export function getGuide(_req: Request, res: Response) {
  res.set("Cache-Control", "public, max-age=3600");
  res.json(GUIDE);
}

// GET /api/public/guide/:key (flood, cyclone, fire, power_outage, water_outage, health, security, transport, network...)
export function getGuideEntry(req: Request, res: Response) {
  const entry = GUIDE.entries.find((item) => item.key === req.params.key);
  if (!entry) return res.status(404).json({ message: `Consigne inconnue (${GUIDE_KEYS.join(", ")})` });
  res.set("Cache-Control", "public, max-age=3600");
  res.json(entry);
}

// ── État des services et avis d'incident ──────────────────────────────────────────────────

const iso = (date: Date | null) => (date ? date.toISOString() : null);

async function computeStatus() {
  const dbUp = await probeDatabase();
  const db = databaseState();
  const notice = readNotice();
  const copy = (key: string) => (dbUp ? "live" : snapshotDate(key) || snapshotDate("essentials") ? "last_known" : "unavailable");
  const features = [
    { key: "emergency", mode: "live", label: { fr: "Numéro d'urgence", en: "Emergency number" } },
    { key: "guide", mode: "live", label: { fr: "Consignes « que faire en cas de... »", en: "What-to-do guidance" } },
    { key: "alerts", mode: copy("alerts:public:all"), label: { fr: "Alertes en cours", en: "Current alerts" } },
    { key: "contacts", mode: copy("contacts:public:all"), label: { fr: "Coordonnées utiles", en: "Useful contacts" } },
    { key: "transport", mode: copy("transport:network"), label: { fr: "Horaires et état des transports", en: "Transport timetables and status" } },
    {
      key: "signalements",
      mode: dbUp ? "live" : "queued",
      label: { fr: "Signaler un problème", en: "Report a problem" },
      fallback: dbUp ? null : { fr: "Votre signalement est gardé sur l'appareil et sera transmis automatiquement.", en: "Your report is kept on the device and will be sent automatically." },
    },
    { key: "account", mode: dbUp ? "live" : "unavailable", label: { fr: "Compte, demandes et rendez-vous", en: "Account, requests and appointments" } },
    { key: "ai", mode: aiApiKey() ? "live" : "unavailable", label: { fr: "Assistance par IA", en: "AI assistance" } },
  ].map((feature) => {
    // L'avis d'incident peut déclarer une fonction indisponible (un bug, un prestataire en panne...) même si la base répond
    const declaredDown = notice?.affected.includes(feature.key as NoticeFeature) ?? false;
    const mode = declaredDown ? "unavailable" : feature.mode;
    return { ...feature, available: mode !== "unavailable" && mode !== "queued", mode, declaredByNotice: declaredDown };
  });

  const status = !dbUp ? "degraded" : notice ? "incident" : "ok";
  const dbMessage = {
    fr: `Service partiellement indisponible. Les alertes, les consignes, les coordonnées utiles et les horaires restent consultables. Les signalements seront transmis dès le retour du service ; en cas d'urgence vitale, appelez le ${EMERGENCY_NUMBER}.`,
    en: `Service partly unavailable. Alerts, guidance, useful contacts and timetables remain available. Reports will be sent as soon as service returns; for a life-threatening emergency, call ${EMERGENCY_NUMBER}.`,
  };
  const message = notice
    ? { fr: notice.message, en: notice.messageEn ?? notice.message }
    : dbUp
      ? { fr: "Tous les services fonctionnent.", en: "All services are running." }
      : dbMessage;
  return {
    status,
    database: dbUp ? "up" : "down",
    downSince: iso(db.downSince),
    lastUpdateAt: iso(snapshotDate("essentials") ?? db.lastOkAt),
    notice,
    features,
    message,
    // Panne de base ET avis : le message technique reste disponible en plus de l'avis
    details: notice && !dbUp ? dbMessage : null,
  };
}

// GET /api/status -> ce qui fonctionne et ce qui ne fonctionne pas, en clair. Le client l'appelle quand une requête
// échoue, pour afficher « Mode dégradé : ... » au lieu d'un message d'erreur technique.
export async function serviceStatus(_req: Request, res: Response) {
  res.set("Cache-Control", "no-store");
  res.json(await computeStatus());
}

// PUT /api/platform/notice { message, messageEn?, severity?: "info"|"warning", affected?: [features] }
export function putNotice(req: Request, res: Response) {
  const message = typeof req.body?.message === "string" ? req.body.message.replace(/\s+/g, " ").trim() : "";
  if (message.length < 10 || message.length > 500) {
    return res.status(400).json({ message: "Message de 10 à 500 caractères : ce qui ne marche pas, ce qui marche encore, jusqu'à quand" });
  }
  const messageEn = req.body?.messageEn === undefined || req.body.messageEn === null ? null : String(req.body.messageEn).trim().slice(0, 500) || null;
  const severity = req.body?.severity ?? "warning";
  if (severity !== "info" && severity !== "warning") return res.status(400).json({ message: "severity : info ou warning" });
  const affected = req.body?.affected ?? [];
  if (!Array.isArray(affected) || !affected.every((key) => (NOTICE_FEATURES as readonly unknown[]).includes(key))) {
    return res.status(400).json({ message: `affected : liste parmi ${NOTICE_FEATURES.join(", ")}` });
  }
  const notice: PlatformNotice = writeNotice({ message, messageEn, severity, affected: [...new Set(affected as NoticeFeature[])] });
  void audit(req, "platform.notice.set", { entityType: "platform" });
  res.json(notice);
}

// DELETE /api/platform/notice -> incident terminé
export function deleteNotice(req: Request, res: Response) {
  const removed = clearNotice();
  void audit(req, "platform.notice.clear", { entityType: "platform" });
  res.status(removed ? 204 : 404).end();
}

// ── Page de secours ───────────────────────────────────────────────────────────────────────

// GET /secours (et /api/public/secours) : une page HTML autonome, légère, sans JavaScript, imprimable. Servie par l'API
// elle-même : elle reste accessible si le site principal est en panne, et lisible hors ligne une fois enregistrée.
export async function essentialsPage(req: Request, res: Response) {
  const lang = req.query.lang === "en" ? "en" : "fr";
  const [{ data, stale, savedAt }, status] = await Promise.all([essentialsData(), computeStatus()]);
  const html = renderEssentialsPage({ lang, data, stale, savedAt, status, guide: GUIDE, emergency: STATIC_ESSENTIALS.emergency, offlineGuide: STATIC_ESSENTIALS.offlineGuide });
  const etag = `"p-${crypto.createHash("sha1").update(html).digest("hex").slice(0, 16)}"`;
  // Aucun script : seuls les styles intégrés sont autorisés
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.set("Cache-Control", "no-cache");
  res.set("ETag", etag);
  if (req.headers["if-none-match"] === etag) return res.status(304).end();
  res.type("html").send(html);
}
