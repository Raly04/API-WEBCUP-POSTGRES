import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model, NonAttribute, Op } from "sequelize";
import sequelize from "../config/database";
import { enumRankQuoted } from "../utils/sql";
import { User } from "./user.model";

// Alerte à la population : un danger en cours dans un ou plusieurs quartiers (montée des eaux, incendie, coupure...).
// Différente d'une annonce : elle vise des QUARTIERS, a un niveau de gravité, des CONSIGNES à suivre, une durée de
// validité (elle disparaît d'elle-même), des mises à jour et une fin d'alerte. Lisible sans compte.

// Quartiers de Terra Nova. Stockés en texte (pas en ENUM) : on peut en ajouter ici sans migration de la base.
export const ZONES = ["north", "south", "east", "west", "center"] as const;
export type Zone = (typeof ZONES)[number];
export const ALL_ZONES = "all";
export const ZONE_LABELS: Record<Zone | typeof ALL_ZONES, { fr: string; en: string }> = {
  north: { fr: "Quartier nord", en: "North district" },
  south: { fr: "Quartier sud", en: "South district" },
  east: { fr: "Quartier est", en: "East district" },
  west: { fr: "Quartier ouest", en: "West district" },
  center: { fr: "Centre-ville", en: "City centre" },
  all: { fr: "Toute la ville", en: "Whole city" },
};
export const isZone = (value: unknown): value is Zone => (ZONES as readonly unknown[]).includes(value);

export const ALERT_HAZARDS = ["flood", "heavy_rain", "cyclone", "fire", "power_outage", "water_outage", "security", "health", "transport", "network", "other"] as const;
export type AlertHazard = (typeof ALERT_HAZARDS)[number];
export const HAZARD_LABELS: Record<AlertHazard, { fr: string; en: string }> = {
  flood: { fr: "Montée des eaux / inondation", en: "Rising water / flood" },
  heavy_rain: { fr: "Fortes pluies", en: "Heavy rain" },
  cyclone: { fr: "Cyclone", en: "Cyclone" },
  fire: { fr: "Incendie", en: "Fire" },
  power_outage: { fr: "Coupure d'électricité", en: "Power outage" },
  water_outage: { fr: "Coupure d'eau", en: "Water outage" },
  security: { fr: "Sécurité", en: "Security" },
  health: { fr: "Santé publique", en: "Public health" },
  transport: { fr: "Transports perturbés", en: "Transport disruption" },
  network: { fr: "Panne de réseau / communications", en: "Network / communications outage" },
  other: { fr: "Information importante", en: "Important information" },
};
export const isAlertHazard = (value: unknown): value is AlertHazard => (ALERT_HAZARDS as readonly unknown[]).includes(value);

// Niveaux de gravité, du moins au plus grave : un code couleur universel, compris sans lire le texte
export const ALERT_SEVERITIES = ["info", "watch", "warning", "emergency"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export const SEVERITY_INFO: Record<AlertSeverity, { fr: string; en: string; color: "blue" | "yellow" | "orange" | "red"; actionRequired: boolean; defaultMinutes: number }> = {
  info: { fr: "Information", en: "Information", color: "blue", actionRequired: false, defaultMinutes: 24 * 60 },
  watch: { fr: "Vigilance", en: "Watch", color: "yellow", actionRequired: false, defaultMinutes: 24 * 60 },
  warning: { fr: "Alerte : protégez-vous", en: "Warning: protect yourself", color: "orange", actionRequired: true, defaultMinutes: 12 * 60 },
  emergency: { fr: "Urgence : agissez maintenant", en: "Emergency: act now", color: "red", actionRequired: true, defaultMinutes: 6 * 60 },
};
export const isAlertSeverity = (value: unknown): value is AlertSeverity => (ALERT_SEVERITIES as readonly unknown[]).includes(value);

export const ALERT_STATUSES = ["active", "ended"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

// ── Table alerts ─────────────────────────────────────────────
export class Alert extends Model<InferAttributes<Alert>, InferCreationAttributes<Alert>> {
  declare id: CreationOptional<number>;
  declare title: string;
  declare hazard: AlertHazard;
  declare severity: AlertSeverity;
  declare zones: string; // "south" | "south,center" | "all"
  declare message: string;
  declare instructions: CreationOptional<string | null>; // tableau JSON de consignes courtes
  declare status: CreationOptional<AlertStatus>;
  declare startsAt: CreationOptional<Date>;
  declare expiresAt: Date;
  declare endedAt: CreationOptional<Date | null>;
  declare endMessage: CreationOptional<string | null>;
  declare version: CreationOptional<number>;
  declare createdBy: CreationOptional<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date | null>;
  declare author?: NonAttribute<Pick<User, "id" | "firstName" | "lastName"> | null>;
}

Alert.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    title: { type: DataTypes.STRING(160), allowNull: false },
    hazard: { type: DataTypes.ENUM(...ALERT_HAZARDS), allowNull: false },
    severity: { type: DataTypes.ENUM(...ALERT_SEVERITIES), allowNull: false },
    zones: { type: DataTypes.STRING(100), allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: false },
    instructions: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.ENUM(...ALERT_STATUSES), allowNull: false, defaultValue: "active" },
    startsAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    endedAt: { type: DataTypes.DATE, allowNull: true },
    endMessage: { type: DataTypes.TEXT, allowNull: true },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    createdBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: "alerts", underscored: true }
);
Alert.belongsTo(User, { foreignKey: "createdBy", as: "author" });

// ── Table alert_updates : l'évolution de la situation (« 11 h : l'eau continue de monter, rue des Serres fermée ») ──
export class AlertUpdate extends Model<InferAttributes<AlertUpdate>, InferCreationAttributes<AlertUpdate>> {
  declare id: CreationOptional<number>;
  declare alertId: number;
  declare message: string;
  declare severity: CreationOptional<AlertSeverity | null>;
  declare createdBy: CreationOptional<number | null>;
  declare createdAt: CreationOptional<Date>;
}

AlertUpdate.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    alertId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: false },
    severity: { type: DataTypes.STRING(20), allowNull: true },
    createdBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "alert_updates", timestamps: false }
);

export type AlertData = InferAttributes<Alert> & {
  author?: { id: number; firstName: string; lastName: string } | null;
  updates?: InferAttributes<AlertUpdate>[];
};

const SEVERITY_ORDER = sequelize.literal(enumRankQuoted('"Alert"."severity"', ["emergency", "warning", "watch", "info"]));

// Une alerte « concerne » un quartier si elle le vise explicitement, ou si elle vise toute la ville.
// MySQL : FIND_IN_SET(zone, zones) > 0. PostgreSQL n'a pas FIND_IN_SET ; on découpe la liste
// texte avec string_to_array et on teste l'appartenance avec `= ANY(...)`, qui est l'exact
// équivalent (comparaison d'un élément, pas d'une sous-chaîne).
function zoneCondition(zone?: Zone) {
  if (!zone) return {};
  const quoted = sequelize.escape(zone);
  const targets = sequelize.literal(`(${quoted} = ANY(string_to_array("Alert"."zones", ',')))`);
  return { [Op.or]: [targets, { zones: ALL_ZONES }] };
}

async function withUpdates(alerts: Alert[], perAlert: number): Promise<AlertData[]> {
  const plain = alerts.map((alert) => alert.get({ plain: true }) as AlertData);
  if (plain.length === 0) return plain;
  const updates = await AlertUpdate.findAll({ where: { alertId: plain.map((a) => a.id) }, order: [["createdAt", "DESC"], ["id", "DESC"]] });
  for (const alert of plain) {
    alert.updates = updates.filter((u) => Number(u.alertId) === Number(alert.id)).slice(0, perAlert).map((u) => u.get({ plain: true }));
  }
  return plain;
}

export const AlertModel = {
  // En vigueur MAINTENANT : active, commencée, pas encore expirée. Les plus graves d'abord.
  async listActive(zone?: Zone, perAlert = 5): Promise<AlertData[]> {
    const now = new Date();
    const alerts = await Alert.findAll({
      where: { [Op.and]: [{ status: "active", startsAt: { [Op.lte]: now }, expiresAt: { [Op.gt]: now } }, zoneCondition(zone)] } as any,
      order: [[SEVERITY_ORDER, "ASC"], ["updatedAt", "DESC"], ["id", "DESC"]],
    });
    return withUpdates(alerts, perAlert);
  },

  // Fins d'alerte récentes : savoir que le danger est passé fait partie de l'information
  async listRecentlyEnded(zone?: Zone, withinHours = 6): Promise<AlertData[]> {
    const alerts = await Alert.findAll({
      where: { [Op.and]: [{ status: "ended", endedAt: { [Op.gt]: new Date(Date.now() - withinHours * 3600_000) } }, zoneCondition(zone)] } as any,
      order: [["endedAt", "DESC"]],
      limit: 10,
    });
    return withUpdates(alerts, 1);
  },

  async listAll(filters: { status?: AlertStatus; limit: number; offset: number }) {
    const { rows, count } = await Alert.findAndCountAll({
      where: filters.status ? { status: filters.status } : {},
      include: [{ model: User, as: "author", attributes: ["id", "firstName", "lastName"] }],
      order: [["id", "DESC"]],
      limit: filters.limit,
      offset: filters.offset,
    });
    return { alerts: await withUpdates(rows, 50), total: count };
  },

  async findById(id: number): Promise<AlertData | null> {
    const row = await Alert.findByPk(id, { include: [{ model: User, as: "author", attributes: ["id", "firstName", "lastName"] }] });
    return row ? (await withUpdates([row], 50))[0] : null;
  },

  async create(data: {
    title: string; hazard: AlertHazard; severity: AlertSeverity; zones: string; message: string; instructions: string[]; expiresAt: Date; createdBy: number;
  }): Promise<AlertData> {
    const created = await Alert.create({ ...data, instructions: JSON.stringify(data.instructions), status: "active", version: 1 });
    return (await AlertModel.findById(created.id))!;
  },

  // Mise à jour de la situation : une ligne d'évolution + éventuellement nouvelle gravité, nouvelles consignes, prolongation
  async addUpdate(
    id: number,
    data: { message: string; severity?: AlertSeverity; instructions?: string[]; expiresAt?: Date; createdBy: number }
  ): Promise<AlertData | null> {
    await sequelize.transaction(async (transaction) => {
      const alert = await Alert.findByPk(id, { transaction });
      if (!alert) return;
      await alert.update(
        {
          ...(data.severity ? { severity: data.severity } : {}),
          ...(data.instructions ? { instructions: JSON.stringify(data.instructions) } : {}),
          ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}),
          version: alert.version + 1,
          updatedAt: new Date(),
        },
        { transaction }
      );
      await AlertUpdate.create({ alertId: id, message: data.message, severity: data.severity ?? null, createdBy: data.createdBy }, { transaction });
    });
    return AlertModel.findById(id);
  },

  async end(id: number, endMessage: string, endedBy: number): Promise<AlertData | null> {
    await sequelize.transaction(async (transaction) => {
      const alert = await Alert.findByPk(id, { transaction });
      if (!alert) return;
      const now = new Date();
      await alert.update({ status: "ended", endedAt: now, endMessage, version: alert.version + 1, updatedAt: now }, { transaction });
      await AlertUpdate.create({ alertId: id, message: endMessage, severity: null, createdBy: endedBy }, { transaction });
    });
    return AlertModel.findById(id);
  },
};
