import {
  CreationOptional,
  DataTypes,
  IncludeOptions,
  InferAttributes,
  InferCreationAttributes,
  Model,
  NonAttribute,
  Op,
  QueryTypes,
  Transaction,
} from "sequelize";
import sequelize from "../config/database";
import { enumRankQuoted, sqlMinutesSince } from "../utils/sql";
import type { Zone } from "./alert.model";
import { User } from "./user.model";

// Un signalement n'est PAS une demande ordinaire : urgence médicale, incendie, inondation, panne... Il se traite en
// minutes, pas en jours. Trois choses le distinguent d'une demande : sa priorité vient de son TYPE (le déclarant ne
// peut pas la baisser), un délai de prise en charge est visé selon la priorité, et la liste du personnel est triée
// par ce qui demande réellement de l'attention, pas par date.

export const SIGNALEMENT_TYPES = ["medical", "breakdown", "fire", "cyclone", "heavy_rain", "flood", "accident", "security", "other"] as const;
export type SignalementType = (typeof SIGNALEMENT_TYPES)[number];

export const SIGNALEMENT_PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type SignalementPriority = (typeof SIGNALEMENT_PRIORITIES)[number];

export const SIGNALEMENT_STATUSES = ["new", "acknowledged", "in_progress", "resolved", "cancelled"] as const;
export type SignalementStatus = (typeof SIGNALEMENT_STATUSES)[number];

export const OPEN_STATUSES: SignalementStatus[] = ["new", "acknowledged", "in_progress"];
export const CLOSED_STATUSES: SignalementStatus[] = ["resolved", "cancelled"];

export const isSignalementType = (value: unknown): value is SignalementType => (SIGNALEMENT_TYPES as readonly unknown[]).includes(value);
export const isSignalementPriority = (value: unknown): value is SignalementPriority =>
  (SIGNALEMENT_PRIORITIES as readonly unknown[]).includes(value);
export const isSignalementStatus = (value: unknown): value is SignalementStatus =>
  (SIGNALEMENT_STATUSES as readonly unknown[]).includes(value);

// Règles par type. `emergency` : danger pour les personnes, l'alerte n'attend jamais (urgente d'office, jamais bloquée par
// l'anti-robots, signalée en temps réel au personnel).
export const TYPE_RULES: Record<SignalementType, { defaultPriority: SignalementPriority; emergency: boolean; label: { fr: string; en: string } }> = {
  medical: { defaultPriority: "urgent", emergency: true, label: { fr: "Urgence médicale", en: "Medical emergency" } },
  fire: { defaultPriority: "urgent", emergency: true, label: { fr: "Incendie", en: "Fire" } },
  flood: { defaultPriority: "high", emergency: false, label: { fr: "Inondation", en: "Flood" } },
  cyclone: { defaultPriority: "high", emergency: false, label: { fr: "Cyclone", en: "Cyclone" } },
  accident: { defaultPriority: "high", emergency: false, label: { fr: "Accident", en: "Accident" } },
  security: { defaultPriority: "high", emergency: false, label: { fr: "Sécurité", en: "Security" } },
  breakdown: { defaultPriority: "medium", emergency: false, label: { fr: "Panne", en: "Breakdown" } },
  heavy_rain: { defaultPriority: "medium", emergency: false, label: { fr: "Forte pluie", en: "Heavy rain" } },
  other: { defaultPriority: "low", emergency: false, label: { fr: "Autre signalement", en: "Other report" } },
};

// Délai visé pour PRENDRE EN COMPTE un signalement (minutes), selon sa priorité. Au-delà, il est « en retard » et remonte
// en tête de la liste du personnel.
export const SLA_MINUTES: Record<SignalementPriority, number> = { urgent: 5, high: 30, medium: 240, low: 1440 };

export function minutesSince(date: Date | string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(date).getTime()) / 60_000));
}

export function isOverdue(item: { status: SignalementStatus; priority: SignalementPriority; createdAt: Date | string }): boolean {
  return item.status === "new" && minutesSince(item.createdAt) > SLA_MINUTES[item.priority];
}

// ── Table signalements ───────────────────────────────────────
export class Signalement extends Model<InferAttributes<Signalement>, InferCreationAttributes<Signalement>> {
  declare id: CreationOptional<number>;
  declare userId: CreationOptional<number | null>;
  declare type: SignalementType;
  declare priority: SignalementPriority;
  declare status: CreationOptional<SignalementStatus>;
  declare title: string;
  declare description: CreationOptional<string | null>;
  declare location: string;
  declare zone: CreationOptional<Zone | null>;
  declare contactPhone: CreationOptional<string | null>;
  // Envoi depuis un appareil hors ligne : identifiant choisi par l'appareil (renvoi sans doublon) et heure réelle du constat
  declare clientRef: CreationOptional<string | null>;
  declare reportedAt: CreationOptional<Date | null>;
  declare assignedTo: CreationOptional<number | null>;
  declare acknowledgedAt: CreationOptional<Date | null>;
  declare resolvedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date | null>;
  declare reporter?: NonAttribute<Pick<User, "id" | "firstName" | "lastName"> | null>;
  declare assignee?: NonAttribute<Pick<User, "id" | "firstName" | "lastName"> | null>;
}

Signalement.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    type: { type: DataTypes.ENUM(...SIGNALEMENT_TYPES), allowNull: false },
    priority: { type: DataTypes.ENUM(...SIGNALEMENT_PRIORITIES), allowNull: false },
    status: { type: DataTypes.ENUM(...SIGNALEMENT_STATUSES), allowNull: false, defaultValue: "new" },
    title: { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    location: { type: DataTypes.STRING(255), allowNull: false },
    zone: { type: DataTypes.STRING(20), allowNull: true },
    contactPhone: { type: DataTypes.STRING(30), allowNull: true },
    clientRef: { type: DataTypes.STRING(64), allowNull: true },
    reportedAt: { type: DataTypes.DATE, allowNull: true },
    assignedTo: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    acknowledgedAt: { type: DataTypes.DATE, allowNull: true },
    resolvedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: "signalements", underscored: true }
);

Signalement.belongsTo(User, { foreignKey: "userId", as: "reporter" });
Signalement.belongsTo(User, { foreignKey: "assignedTo", as: "assignee" });

// ── Table signalement_history ────────────────────────────────
export class SignalementHistory extends Model<InferAttributes<SignalementHistory>, InferCreationAttributes<SignalementHistory>> {
  declare id: CreationOptional<number>;
  declare signalementId: number;
  declare action: string;
  declare oldStatus: CreationOptional<SignalementStatus | null>;
  declare newStatus: CreationOptional<SignalementStatus | null>;
  declare oldPriority: CreationOptional<SignalementPriority | null>;
  declare newPriority: CreationOptional<SignalementPriority | null>;
  declare assignedTo: CreationOptional<number | null>;
  declare note: CreationOptional<string | null>;
  declare changedBy: CreationOptional<number | null>;
  declare changedAt: CreationOptional<Date>;
  declare author?: NonAttribute<Pick<User, "id" | "firstName" | "lastName"> | null>;
}

SignalementHistory.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    signalementId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    action: { type: DataTypes.STRING(30), allowNull: false },
    oldStatus: { type: DataTypes.STRING(20), allowNull: true },
    newStatus: { type: DataTypes.STRING(20), allowNull: true },
    oldPriority: { type: DataTypes.STRING(10), allowNull: true },
    newPriority: { type: DataTypes.STRING(10), allowNull: true },
    assignedTo: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    note: { type: DataTypes.TEXT, allowNull: true },
    changedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    changedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "signalement_history", timestamps: false }
);

SignalementHistory.belongsTo(User, { foreignKey: "changedBy", as: "author" });

export type SignalementData = InferAttributes<Signalement> & {
  reporter?: { id: number; firstName: string; lastName: string } | null;
  assignee?: { id: number; firstName: string; lastName: string } | null;
};
export type SignalementHistoryData = InferAttributes<SignalementHistory> & {
  author?: { id: number; firstName: string; lastName: string } | null;
};

const withPeople: IncludeOptions[] = [
  { model: User, as: "reporter", attributes: ["id", "firstName", "lastName"] },
  { model: User, as: "assignee", attributes: ["id", "firstName", "lastName"] },
];

// Même formule que isOverdue(), en SQL, pour que le TRI de la liste et le drapeau « en retard » ne divergent jamais.
// Les colonnes sont citées avec " (double guillemet, quoting PostgreSQL) et non ` (MySQL).
const OVERDUE_SQL = `("Signalement"."status" = 'new' AND ${sqlMinutesSince('"Signalement"."created_at"')} >
  CASE "Signalement"."priority" WHEN 'urgent' THEN ${SLA_MINUTES.urgent} WHEN 'high' THEN ${SLA_MINUTES.high} WHEN 'medium' THEN ${SLA_MINUTES.medium} ELSE ${SLA_MINUTES.low} END)`;

// Rang d'attention (0 = à traiter en premier). L'ordre de la liste du personnel :
//  0 urgent non pris en compte | 1 en retard sur son délai | 2 important non pris en compte
//  3 urgent ou important déjà pris en charge (à suivre) | 4 autre non pris en compte | 5 autre en cours | 6 clos
const ATTENTION_RANK_SQL = `CASE
  WHEN "Signalement"."status" IN ('resolved', 'cancelled') THEN 6
  WHEN "Signalement"."status" = 'new' AND "Signalement"."priority" = 'urgent' THEN 0
  WHEN ${OVERDUE_SQL} THEN 1
  WHEN "Signalement"."status" = 'new' AND "Signalement"."priority" = 'high' THEN 2
  WHEN "Signalement"."priority" IN ('urgent', 'high') THEN 3
  WHEN "Signalement"."status" = 'new' THEN 4
  ELSE 5 END`;

export interface SignalementFilters {
  statuses?: SignalementStatus[];
  priorities?: SignalementPriority[];
  types?: SignalementType[];
  zone?: Zone;
  assignedTo?: number | "none";
  overdueOnly?: boolean;
  userId?: number;
  search?: string;
  sort?: "attention" | "recent" | "oldest";
  limit: number;
  offset: number;
}

export const SignalementModel = {
  async list(filters: SignalementFilters) {
    const where: Record<string | symbol, unknown> = {};
    if (filters.statuses?.length) where.status = { [Op.in]: filters.statuses };
    if (filters.priorities?.length) where.priority = { [Op.in]: filters.priorities };
    if (filters.types?.length) where.type = { [Op.in]: filters.types };
    if (filters.zone) where.zone = filters.zone;
    if (filters.userId !== undefined) where.userId = filters.userId;
    if (filters.assignedTo === "none") where.assignedTo = null;
    else if (filters.assignedTo !== undefined) where.assignedTo = filters.assignedTo;
    // Titre et lieu seulement : la description peut contenir des informations de santé, on ne les rend pas interrogeables
    if (filters.search) {
      where[Op.or] = [{ title: { [Op.iLike]: `%${filters.search}%` } }, { location: { [Op.iLike]: `%${filters.search}%` } }];
    }
    const conditions: unknown[] = [where];
    if (filters.overdueOnly) conditions.push(sequelize.literal(OVERDUE_SQL));

    const order: any[] =
      filters.sort === "recent"
        ? [["createdAt", "DESC"], ["id", "DESC"]]
        : filters.sort === "oldest"
          ? [["createdAt", "ASC"], ["id", "ASC"]]
          : [
              [sequelize.literal(ATTENTION_RANK_SQL), "ASC"],
              // À rang égal : l'urgence d'abord, puis ce qui attend depuis le plus longtemps
              [sequelize.literal(enumRankQuoted('"Signalement"."priority"', ["urgent", "high", "medium", "low"])), "ASC"],
              ["createdAt", "ASC"],
              ["id", "ASC"],
            ];

    const { rows, count } = await Signalement.findAndCountAll({
      where: { [Op.and]: conditions } as any,
      include: withPeople,
      order,
      limit: filters.limit,
      offset: filters.offset,
      distinct: true,
    });
    return { signalements: rows.map((row) => row.get({ plain: true }) as SignalementData), total: count };
  },

  async findById(id: number, transaction?: Transaction): Promise<SignalementData | null> {
    const row = await Signalement.findByPk(id, { include: withPeople, transaction });
    return (row?.get({ plain: true }) as SignalementData | undefined) ?? null;
  },

  // Le propriétaire fait partie de la condition : un identifiant deviné ne donne jamais le signalement d'autrui
  async findOwnedById(id: number, userId: number): Promise<SignalementData | null> {
    const row = await Signalement.findOne({ where: { id, userId }, include: withPeople });
    return (row?.get({ plain: true }) as SignalementData | undefined) ?? null;
  },

  // Double envoi (double-clic, réseau instable) : on retrouve le signalement identique tout juste créé plutôt que d'en
  // ouvrir un second, qui ferait deux alertes pour un seul événement
  // Renvoi d'un même signalement par un appareil revenu en ligne : même compte, même clientRef
  async findByClientRef(userId: number, clientRef: string): Promise<SignalementData | null> {
    const row = await Signalement.findOne({ where: { userId, clientRef }, include: withPeople });
    return (row?.get({ plain: true }) as SignalementData | undefined) ?? null;
  },

  async findRecentDuplicate(userId: number, type: SignalementType, location: string, withinMinutes = 3): Promise<SignalementData | null> {
    const row = await Signalement.findOne({
      where: {
        userId,
        type,
        location,
        status: "new",
        createdAt: { [Op.gt]: new Date(Date.now() - withinMinutes * 60_000) },
      },
      include: withPeople,
      order: [["id", "DESC"]],
    });
    return (row?.get({ plain: true }) as SignalementData | undefined) ?? null;
  },

  async create(
    data: {
      userId: number; type: SignalementType; priority: SignalementPriority; title: string; description: string | null; location: string; zone: Zone | null;
      contactPhone: string | null; clientRef?: string | null; reportedAt?: Date | null;
    }
  ): Promise<SignalementData> {
    return sequelize.transaction(async (transaction) => {
      const created = await Signalement.create({ ...data, status: "new" }, { transaction });
      await SignalementHistory.create(
        { signalementId: created.id, action: "created", oldStatus: null, newStatus: "new", newPriority: data.priority, changedBy: data.userId },
        { transaction }
      );
      return (await SignalementModel.findById(created.id, transaction))!;
    });
  },

  // Applique une modification ET écrit sa ligne d'historique dans la même transaction : jamais de changement sans trace
  async applyChange(
    id: number,
    changes: Partial<{ status: SignalementStatus; priority: SignalementPriority; assignedTo: number | null }>,
    entry: { action: string; changedBy: number; note: string | null }
  ): Promise<SignalementData | null> {
    return sequelize.transaction(async (transaction) => {
      const current = await Signalement.findByPk(id, { transaction });
      if (!current) return null;
      const now = new Date();
      const previousStatus = current.status; // lus AVANT la modification
      const previousPriority = current.priority;
      const update: Record<string, unknown> = { ...changes };
      if (changes.status && changes.status !== "new" && !current.acknowledgedAt) update.acknowledgedAt = now;
      if (changes.status && CLOSED_STATUSES.includes(changes.status)) update.resolvedAt = now;
      if (changes.status && OPEN_STATUSES.includes(changes.status)) update.resolvedAt = null; // réouverture
      update.updatedAt = now;
      await current.update(update, { transaction });
      await SignalementHistory.create(
        {
          signalementId: id,
          action: entry.action,
          oldStatus: changes.status ? previousStatus : null,
          newStatus: changes.status ?? null,
          oldPriority: changes.priority ? previousPriority : null,
          newPriority: changes.priority ?? null,
          assignedTo: changes.assignedTo !== undefined ? changes.assignedTo : null,
          note: entry.note,
          changedBy: entry.changedBy,
        },
        { transaction }
      );
      return SignalementModel.findById(id, transaction);
    });
  },

  async history(signalementId: number): Promise<SignalementHistoryData[]> {
    const rows = await SignalementHistory.findAll({
      where: { signalementId },
      include: [{ model: User, as: "author", attributes: ["id", "firstName", "lastName"] }],
      order: [["changedAt", "ASC"], ["id", "ASC"]],
    });
    return rows.map((row) => row.get({ plain: true }) as SignalementHistoryData);
  },

  // Tableau de bord du personnel : tout ce qu'il faut pour savoir en un coup d'œil s'il y a quelque chose à faire
  async summary(staffUserId: number) {
    const open = OPEN_STATUSES.map((s) => `'${s}'`).join(",");
    // PostgreSQL n'a pas SUM() sur un booléen (MySQL convertit TRUE/FALSE en 1/0) :
    // chaque compteur est donc un CASE WHEN ... THEN 1 ELSE 0 END.
    const count = (condition: string) => `COALESCE(SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END), 0)`;
    const [row] = await sequelize.query<{
      open: number; unacknowledged: number; urgentOpen: number; overdue: number; unassigned: number; mine: number; oldestUnacknowledged: Date | null;
    }>(
      `SELECT
         ${count(`status IN (${open})`)}                                              AS open,
         ${count(`status = 'new'`)}                                                   AS unacknowledged,
         ${count(`status IN (${open}) AND priority = 'urgent'`)}                      AS "urgentOpen",
         ${count(`status = 'new' AND ${sqlMinutesSince("created_at")} >
           CASE priority WHEN 'urgent' THEN ${SLA_MINUTES.urgent} WHEN 'high' THEN ${SLA_MINUTES.high} WHEN 'medium' THEN ${SLA_MINUTES.medium} ELSE ${SLA_MINUTES.low} END`)} AS overdue,
         ${count(`status IN (${open}) AND assigned_to IS NULL`)}                      AS unassigned,
         ${count(`status IN (${open}) AND assigned_to = :staffUserId`)}               AS mine,
         MIN(CASE WHEN status = 'new' THEN created_at END)                            AS "oldestUnacknowledged"
       FROM signalements`,
      { replacements: { staffUserId }, type: QueryTypes.SELECT }
    );
    // "key" est un mot réservé de PostgreSQL : il doit être cité avec des guillemets doubles.
    const grouped = async (column: "priority" | "type") =>
      sequelize.query<{ key: string; total: number }>(
        `SELECT ${column} AS "key", COUNT(*) AS total FROM signalements WHERE status IN (${open}) GROUP BY ${column}`,
        { type: QueryTypes.SELECT }
      );
    const [byPriority, byType, byZoneRows, hotspots] = await Promise.all([
      grouped("priority"),
      grouped("type"),
      sequelize.query<{ key: string; total: number }>(
        `SELECT zone AS "key", COUNT(*) AS total FROM signalements WHERE status IN (${open}) AND zone IS NOT NULL GROUP BY zone`,
        { type: QueryTypes.SELECT }
      ),
      // Points chauds : au moins 2 signalements ouverts du même danger collectif, dans le même quartier, depuis 3 h.
      // C'est le signe qu'il faut peut-être prévenir tout le quartier (voir /api/alerts).
      sequelize.query<{ zone: string; type: string; total: number; latestAt: Date }>(
        `SELECT zone, type, COUNT(*) AS total, MAX(created_at) AS "latestAt" FROM signalements
         WHERE status IN (${open}) AND zone IS NOT NULL AND type IN ('flood', 'heavy_rain', 'cyclone', 'fire')
           AND created_at > NOW() - INTERVAL '3 hours'
         GROUP BY zone, type HAVING COUNT(*) >= 2 ORDER BY total DESC`,
        { type: QueryTypes.SELECT }
      ),
    ]);
    return {
      open: Number(row.open),
      unacknowledged: Number(row.unacknowledged),
      urgentOpen: Number(row.urgentOpen),
      overdue: Number(row.overdue),
      unassigned: Number(row.unassigned),
      mine: Number(row.mine),
      oldestUnacknowledgedMinutes: row.oldestUnacknowledged ? minutesSince(row.oldestUnacknowledged) : null,
      byPriority: Object.fromEntries(byPriority.map((r) => [r.key, Number(r.total)])),
      byType: Object.fromEntries(byType.map((r) => [r.key, Number(r.total)])),
      byZone: Object.fromEntries(byZoneRows.map((r) => [r.key, Number(r.total)])),
      hotspots: hotspots.map((h) => ({ zone: h.zone as Zone, type: h.type as SignalementType, count: Number(h.total), latestAt: h.latestAt })),
    };
  },
};
