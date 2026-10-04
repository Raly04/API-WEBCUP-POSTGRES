import fs from "node:fs";
import path from "node:path";
import sequelize from "../config/database";
import { logger } from "./logger";
import { cached } from "./responseCache";

// Résilience en cas de panne (base de données injoignable, réseau interne coupé) : les informations PUBLIQUES utiles
// en situation de crise (alertes, état des transports, numéros d'urgence) restent servies depuis leur dernière version
// connue, clairement marquée comme telle (stale + date), au lieu d'une erreur 503. Les dernières versions sont gardées
// en mémoire et sur disque (data/snapshots) : elles survivent à un redémarrage de l'API pendant la panne.

const SNAPSHOT_DIR = path.resolve(process.env.SNAPSHOT_DIR ?? path.join(process.cwd(), "data", "snapshots"));
const PERSIST_EVERY_MS = 5 * 60_000;
const LOAD_TIMEOUT_MS = Number(process.env.DB_READ_TIMEOUT_MS) || 3000;

export function isDatabaseUnavailable(err: any): boolean {
  const text = `${err?.name} ${err?.parent?.code ?? err?.original?.code ?? err?.code ?? ""} ${err?.message ?? ""}`;
  return /ConnectionAcquireTimeout|ConnectionRefused|ConnectionTimedOut|ConnectionError|ER_CON_COUNT_ERROR|PROTOCOL_CONNECTION_LOST|ECONNREFUSED|ETIMEDOUT|DB_READ_TIMEOUT/i.test(text);
}

// ── État de la base, vu par les lectures réelles (pas seulement par une sonde) ─────────────────
let dbDownSince: number | null = null;
let lastDbOkAt: number | null = null;

function markDb(ok: boolean) {
  if (ok) {
    if (dbDownSince) logger.info("RESILIENCE", `Base de données de retour après ${Math.round((Date.now() - dbDownSince) / 1000)} s`);
    dbDownSince = null;
    lastDbOkAt = Date.now();
  } else if (!dbDownSince) {
    dbDownSince = Date.now();
    logger.warn("RESILIENCE", "Base de données injoignable : informations publiques servies depuis leur dernière version connue");
  }
}

export function databaseState() {
  return { up: dbDownSince === null, downSince: dbDownSince ? new Date(dbDownSince) : null, lastOkAt: lastDbOkAt ? new Date(lastDbOkAt) : null };
}

// Sonde légère, utilisée par /api/status (au plus une fois toutes les 3 s)
export async function probeDatabase(): Promise<boolean> {
  return cached("resilience:probe", 3000, async () => {
    try {
      await withTimeout(sequelize.query("SELECT 1"), 1500);
      markDb(true);
      return true;
    } catch {
      markDb(false);
      return false;
    }
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(Object.assign(new Error("DB_READ_TIMEOUT"), { code: "DB_READ_TIMEOUT" })), ms).unref()),
  ]);
}

// ── Dernières versions connues ──────────────────────────────────────────────────────────────
interface Snapshot {
  data: unknown;
  savedAt: number;
}
const snapshots = new Map<string, Snapshot>();
const lastPersisted = new Map<string, { content: string; at: number }>();
const fileOf = (key: string) => path.join(SNAPSHOT_DIR, `${key.replace(/[^a-z0-9_-]+/gi, "_")}.json`);

function readFromDisk(key: string): Snapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileOf(key), "utf8"));
    return parsed && typeof parsed.savedAt === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function remember(key: string, data: unknown, persist: boolean) {
  const snapshot = { data, savedAt: Date.now() };
  snapshots.set(key, snapshot);
  if (!persist) return;
  // Sur disque : dès que le contenu change (une alerte vient d'être publiée), sinon de temps en temps pour la date
  const content = JSON.stringify(data);
  const previous = lastPersisted.get(key);
  if (previous && previous.content === content && Date.now() - previous.at < PERSIST_EVERY_MS) return;
  lastPersisted.set(key, { content, at: Date.now() });
  // Écriture atomique (fichier temporaire puis renommage) : un arrêt brutal ne laisse jamais un fichier à moitié écrit
  fs.promises
    .mkdir(SNAPSHOT_DIR, { recursive: true })
    .then(async () => {
      const target = fileOf(key);
      await fs.promises.writeFile(`${target}.tmp`, JSON.stringify(snapshot));
      await fs.promises.rename(`${target}.tmp`, target);
    })
    .catch((error) => logger.warn("RESILIENCE", `Copie de secours « ${key} » non écrite : ${(error as Error).message}`));
}

export interface Resilient<T> {
  data: T;
  stale: boolean; // true : base injoignable, ceci est la dernière version connue
  savedAt: Date; // quand cette version a été lue en base
}

/**
 * Lecture en cache (comme `cached`) qui, si la base est injoignable ou trop lente, rend la dernière version connue.
 * Sans version connue, l'erreur remonte (503). `persist` : garder aussi une copie sur disque.
 */
export async function resilientCached<T>(key: string, ttlMs: number, load: () => Promise<T>, options: { persist?: boolean } = {}): Promise<Resilient<T>> {
  try {
    const data = await cached(key, ttlMs, async () => {
      const fresh = await withTimeout(load(), LOAD_TIMEOUT_MS);
      markDb(true);
      remember(key, fresh, options.persist ?? false);
      return fresh;
    });
    return { data, stale: false, savedAt: new Date(snapshots.get(key)?.savedAt ?? Date.now()) };
  } catch (error) {
    if (!isDatabaseUnavailable(error)) throw error;
    markDb(false);
    let snapshot = snapshots.get(key) ?? null;
    if (!snapshot && options.persist) {
      snapshot = readFromDisk(key);
      if (snapshot) snapshots.set(key, snapshot);
    }
    if (!snapshot) throw error;
    return { data: snapshot.data as T, stale: true, savedAt: new Date(snapshot.savedAt) };
  }
}

// Une copie existe-t-elle (en mémoire ou sur disque) ? Et de quand date-t-elle ?
export function snapshotDate(key: string): Date | null {
  const snapshot = snapshots.get(key) ?? readFromDisk(key);
  return snapshot ? new Date(snapshot.savedAt) : null;
}

// En-têtes posés sur une réponse servie depuis une copie : le client affiche « Informations du 14:02, connexion perdue »
export function staleHeaders(res: { set: (name: string, value: string) => unknown }, result: Resilient<unknown>) {
  if (!result.stale) return;
  res.set("X-Data-Stale", "1");
  res.set("X-Data-Saved-At", result.savedAt.toISOString());
}
