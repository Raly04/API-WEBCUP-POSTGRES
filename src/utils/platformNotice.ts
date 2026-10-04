import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";

// Avis d'incident sur la plateforme : « Les rendez-vous en ligne sont indisponibles, réparation en cours. Les alertes, les
// consignes et les coordonnées utiles restent consultables. » Publié par un administrateur, il dit aux habitants ce qui
// marche encore, pour qu'ils n'aient pas à tout essayer.
//
// Stocké dans un FICHIER, pas en base : il doit rester lisible quand la base est en panne, et pouvoir être posé par
// l'exploitant sans passer par l'API (éditer data/platform-notice.json, voir le README) si la panne empêche de se connecter.

export const NOTICE_FEATURES = ["alerts", "transport", "contacts", "signalements", "account", "ai"] as const;
export type NoticeFeature = (typeof NOTICE_FEATURES)[number];

export interface PlatformNotice {
  message: string;
  messageEn: string | null;
  severity: "info" | "warning";
  affected: NoticeFeature[]; // fonctions indiquées comme indisponibles
  since: string;
  updatedAt: string;
}

const FILE = path.resolve(process.env.PLATFORM_NOTICE_FILE ?? path.join(process.cwd(), "data", "platform-notice.json"));

let cache: { mtimeMs: number; notice: PlatformNotice | null } | null = null;

function sanitize(raw: any): PlatformNotice | null {
  if (!raw || typeof raw.message !== "string" || !raw.message.trim()) return null;
  return {
    message: raw.message.trim().slice(0, 500),
    messageEn: typeof raw.messageEn === "string" && raw.messageEn.trim() ? raw.messageEn.trim().slice(0, 500) : null,
    severity: raw.severity === "warning" ? "warning" : "info",
    affected: Array.isArray(raw.affected) ? raw.affected.filter((key: unknown) => (NOTICE_FEATURES as readonly unknown[]).includes(key)) : [],
    since: typeof raw.since === "string" ? raw.since : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
  };
}

// Relu seulement si le fichier a changé (édition à la main prise en compte sans redémarrer)
export function readNotice(): PlatformNotice | null {
  try {
    const { mtimeMs } = fs.statSync(FILE);
    if (cache && cache.mtimeMs === mtimeMs) return cache.notice;
    const notice = sanitize(JSON.parse(fs.readFileSync(FILE, "utf8")));
    cache = { mtimeMs, notice };
    return notice;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.warn("NOTICE", `Avis d'incident illisible (${FILE}) : ${(error as Error).message}`);
    cache = null;
    return null;
  }
}

export function writeNotice(data: Omit<PlatformNotice, "since" | "updatedAt">): PlatformNotice {
  const previous = readNotice();
  const now = new Date().toISOString();
  const notice: PlatformNotice = { ...data, since: previous?.since ?? now, updatedAt: now };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(notice, null, 2));
  fs.renameSync(`${FILE}.tmp`, FILE);
  cache = null;
  return notice;
}

export function clearNotice(): boolean {
  cache = null;
  try {
    fs.unlinkSync(FILE);
    return true;
  } catch {
    return false;
  }
}
