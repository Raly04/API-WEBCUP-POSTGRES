import { AuditLog } from "../models/auditLog.model";
import { logger } from "./logger";

export interface AuditEntry {
  userId: number | null;
  action: string;
  entityType?: string;
  entityId?: number;
  ipAddress?: string;
  createdAt: Date;
}

// File d'attente en mémoire : l'audit de chaque requête ne coûte qu'un push, jamais un aller-retour SQL
// avant la réponse. Les lignes sont insérées en lot (une seule requête INSERT) toutes les secondes.
const FLUSH_INTERVAL_MS = 1000;
const BATCH_SIZE = 100;
const MAX_QUEUE = 10_000; // garde-fou mémoire si la base est indisponible

let queue: AuditEntry[] = [];
let flushing: Promise<void> | null = null;
let dropped = 0;

export function enqueueAudit(entry: AuditEntry) {
  if (queue.length >= MAX_QUEUE) {
    queue.shift(); // on sacrifie le plus ancien
    dropped++;
    if (dropped === 1 || dropped % 1000 === 0) {
      logger.warn("AUDIT", `File d'audit pleine (${MAX_QUEUE}) : ${dropped} ligne(s) perdue(s). La base est-elle joignable ?`);
    }
  }
  queue.push(entry);
  if (queue.length >= BATCH_SIZE) void flushAuditQueue();
}

// Base injoignable (et non données invalides) : le lot doit être conservé et réessayé, pas écrit ligne à ligne
function isConnectionError(err: any): boolean {
  const text = `${err?.name} ${err?.parent?.code ?? err?.original?.code ?? err?.code ?? ""} ${err?.message ?? ""}`;
  return /Connection|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|PROTOCOL_CONNECTION_LOST|pool/i.test(text);
}

async function insertBatch(batch: AuditEntry[]) {
  try {
    await AuditLog.bulkCreate(batch);
  } catch (batchError) {
    if (isConnectionError(batchError)) throw batchError;
    // Une ligne pose problème (typiquement un user_id supprimé entre-temps : clé étrangère) :
    // on réessaie ligne à ligne, sans l'auteur si c'est lui le problème, pour ne perdre que le strict nécessaire.
    for (const entry of batch) {
      try {
        await AuditLog.create(entry);
      } catch {
        try {
          await AuditLog.create({ ...entry, userId: null });
        } catch (err) {
          logger.error("AUDIT", `Ligne d'audit perdue ("${entry.action}")`, err instanceof Error ? err.message : err);
        }
      }
    }
  }
}

// Vide la file. Un seul vidage à la fois : les appels simultanés attendent le vidage en cours.
export function flushAuditQueue(): Promise<void> {
  if (flushing) return flushing;
  if (queue.length === 0) return Promise.resolve();

  flushing = (async () => {
    try {
      while (queue.length > 0) {
        const batch = queue.splice(0, BATCH_SIZE);
        try {
          await insertBatch(batch);
        } catch (err) {
          queue.unshift(...batch); // base injoignable : on garde et on réessaiera au prochain tour
          logger.error("AUDIT", "Écriture du lot d'audit impossible, nouvel essai plus tard", err instanceof Error ? err.message : err);
          return;
        }
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

// Timer qui n'empêche pas le process de s'arrêter
setInterval(() => void flushAuditQueue(), FLUSH_INTERVAL_MS).unref();
