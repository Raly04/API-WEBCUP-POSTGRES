import { Request, Response } from "express";
import { QueryTypes } from "sequelize";
import sequelize from "../config/database";
import { BOT_MODE, liveStats } from "../utils/botSignals";

// GET /api/security/bots?hours=24
// Ce que la protection a réellement vu et bloqué : lu dans le journal d'audit (durable, survit aux redémarrages),
// complété par les compteurs en mémoire depuis le démarrage de cette instance.
export async function botStats(req: Request, res: Response) {
  const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 24));
  const replacements = { hours };

  const [byAction, byForm, topIps, recent] = await Promise.all([
    sequelize.query<{ action: string; total: number }>(
      `SELECT action, COUNT(*) AS total FROM audit_logs
       WHERE action LIKE 'bot.%' AND created_at > NOW() - (:hours * INTERVAL '1 hour') GROUP BY action`,
      { replacements, type: QueryTypes.SELECT }
    ),
    sequelize.query<{ form: string; total: number }>(
      `SELECT entity_type AS form, COUNT(*) AS total FROM audit_logs
       WHERE action LIKE 'bot.%' AND action <> 'bot.blocked' AND created_at > NOW() - (:hours * INTERVAL '1 hour')
       GROUP BY entity_type ORDER BY total DESC`,
      { replacements, type: QueryTypes.SELECT }
    ),
    sequelize.query<{ ip: string; signals: number; lastAt: Date }>(
      `SELECT ip_address AS ip, COUNT(*) AS signals, MAX(created_at) AS "lastAt" FROM audit_logs
       WHERE action LIKE 'bot.%' AND action <> 'bot.blocked' AND created_at > NOW() - (:hours * INTERVAL '1 hour')
       GROUP BY ip_address ORDER BY signals DESC LIMIT 10`,
      { replacements, type: QueryTypes.SELECT }
    ),
    sequelize.query<{ action: string; form: string | null; ip: string | null; at: Date }>(
      `SELECT action, entity_type AS form, ip_address AS ip, created_at AS at FROM audit_logs
       WHERE action LIKE 'bot.%' AND created_at > NOW() - (:hours * INTERVAL '1 hour') ORDER BY id DESC LIMIT 20`,
      { replacements, type: QueryTypes.SELECT }
    ),
  ]);

  const byReason: Record<string, number> = {};
  let blocks = 0;
  for (const row of byAction) {
    const total = Number(row.total);
    if (row.action === "bot.blocked") blocks = total;
    else byReason[row.action.slice(4)] = total;
  }

  res.json({
    mode: BOT_MODE,
    hours,
    totalSignals: Object.values(byReason).reduce((sum, count) => sum + count, 0),
    blocks,
    byReason,
    byForm: Object.fromEntries(byForm.map((row) => [row.form, Number(row.total)])),
    topIps: topIps.map((row) => ({ ip: row.ip, signals: Number(row.signals), lastAt: row.lastAt })),
    recent,
    // Depuis le démarrage de cette instance : inclut les tentatives déjà bloquées (non écrites en base)
    live: liveStats(),
  });
}
