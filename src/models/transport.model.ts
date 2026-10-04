import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model, Op } from "sequelize";
import sequelize from "../config/database";
import type { Zone } from "./alert.model";
import { Alert } from "./alert.model";

// Réseau de transport de Terra Nova (navettes entre les dômes, tram, téléphérique) et ses interruptions.
// Une interruption vise UNE ligne, sur toute sa longueur ou entre deux arrêts, et porte les solutions de remplacement
// proposées par les services (autre ligne, bus de remplacement, marche...). Plusieurs interruptions déclarées ensemble
// partagent une même alerte à la population (hazard « transport »).

export const TRANSPORT_MODES = ["bus", "tram", "shuttle", "cable"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];
export const MODE_LABELS: Record<TransportMode, { fr: string; en: string }> = {
  bus: { fr: "Bus", en: "Bus" },
  tram: { fr: "Tram", en: "Tram" },
  shuttle: { fr: "Navette", en: "Shuttle" },
  cable: { fr: "Téléphérique", en: "Cable car" },
};

// interrupted : plus aucun passage sur la section ; delayed : ça circule, mais avec retards ou fréquence réduite
export const DISRUPTION_KINDS = ["interrupted", "delayed"] as const;
export type DisruptionKind = (typeof DISRUPTION_KINDS)[number];
export const KIND_LABELS: Record<DisruptionKind, { fr: string; en: string }> = {
  interrupted: { fr: "Interrompue", en: "Interrupted" },
  delayed: { fr: "Perturbée", en: "Delayed" },
};
export const isDisruptionKind = (value: unknown): value is DisruptionKind => (DISRUPTION_KINDS as readonly unknown[]).includes(value);

// Solutions de remplacement saisies par l'agent
export const ALTERNATIVE_KINDS = ["line", "replacement_bus", "walk", "on_demand", "other"] as const;
export type AlternativeKind = (typeof ALTERNATIVE_KINDS)[number];
export const ALTERNATIVE_LABELS: Record<AlternativeKind, { fr: string; en: string }> = {
  line: { fr: "Autre ligne", en: "Other line" },
  replacement_bus: { fr: "Bus de remplacement", en: "Replacement bus" },
  walk: { fr: "À pied", en: "On foot" },
  on_demand: { fr: "Navette à la demande", en: "On-demand shuttle" },
  other: { fr: "Autre solution", en: "Other option" },
};
export const isAlternativeKind = (value: unknown): value is AlternativeKind => (ALTERNATIVE_KINDS as readonly unknown[]).includes(value);

// Horaires d'une ligne : départs des deux terminus de `first` à `last`, toutes les `frequencyMinutes` minutes, plus
// souvent aux heures de pointe. Jours de service en ISO (1 = lundi ... 7 = dimanche). Heures locales « HH:MM ».
export interface LineSchedule {
  days: number[];
  first: string;
  last: string;
  peaks: { from: string; to: string; every: number }[];
}

export interface Alternative {
  kind: AlternativeKind;
  text: string; // phrase à lire telle quelle : « Prenez le tram T1 à Gare Centrale »
  line?: string; // code de la ligne conseillée (kind = line)
  from?: string; // bus de remplacement : arrêts desservis
  to?: string;
  extraMinutes?: number; // temps de trajet en plus, environ
}

// ── Table transport_lines ────────────────────────────────────
export class TransportLine extends Model<InferAttributes<TransportLine>, InferCreationAttributes<TransportLine>> {
  declare id: CreationOptional<number>;
  declare code: string;
  declare name: string;
  declare mode: TransportMode;
  declare color: string;
  declare stops: string; // tableau JSON des arrêts, dans l'ordre
  declare zones: string; // "north,center"
  declare frequencyMinutes: CreationOptional<number | null>;
  declare minutesBetweenStops: CreationOptional<number>;
  declare schedule: CreationOptional<string | null>; // LineSchedule en JSON
  declare wheelchairAccessible: CreationOptional<boolean>;
  declare notes: CreationOptional<string | null>; // infos pratiques : tarif, accessibilité, bagages...
  declare active: CreationOptional<boolean>;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date | null>;
}

TransportLine.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    code: { type: DataTypes.STRING(10), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    mode: { type: DataTypes.ENUM(...TRANSPORT_MODES), allowNull: false },
    color: { type: DataTypes.STRING(7), allowNull: false },
    stops: { type: DataTypes.TEXT, allowNull: false },
    zones: { type: DataTypes.STRING(100), allowNull: false },
    frequencyMinutes: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    minutesBetweenStops: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 3 },
    schedule: { type: DataTypes.TEXT, allowNull: true },
    wheelchairAccessible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notes: { type: DataTypes.STRING(300), allowNull: true },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: "transport_lines", underscored: true }
);

// ── Table transport_disruptions ──────────────────────────────
export class TransportDisruption extends Model<InferAttributes<TransportDisruption>, InferCreationAttributes<TransportDisruption>> {
  declare id: CreationOptional<number>;
  declare lineId: number;
  declare alertId: CreationOptional<number | null>;
  declare kind: DisruptionKind;
  declare fromStop: CreationOptional<string | null>; // null + null : toute la ligne
  declare toStop: CreationOptional<string | null>;
  declare reason: string;
  declare alternatives: CreationOptional<string | null>; // tableau JSON d'Alternative
  declare status: CreationOptional<"active" | "ended">;
  declare startsAt: CreationOptional<Date>;
  declare expectedEndAt: CreationOptional<Date | null>;
  declare endedAt: CreationOptional<Date | null>;
  declare createdBy: CreationOptional<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date | null>;
}

TransportDisruption.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    lineId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    alertId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    kind: { type: DataTypes.ENUM(...DISRUPTION_KINDS), allowNull: false },
    fromStop: { type: DataTypes.STRING(120), allowNull: true },
    toStop: { type: DataTypes.STRING(120), allowNull: true },
    reason: { type: DataTypes.STRING(200), allowNull: false },
    alternatives: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.ENUM("active", "ended"), allowNull: false, defaultValue: "active" },
    startsAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    expectedEndAt: { type: DataTypes.DATE, allowNull: true },
    endedAt: { type: DataTypes.DATE, allowNull: true },
    createdBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: "transport_disruptions", underscored: true }
);

TransportDisruption.belongsTo(TransportLine, { foreignKey: "lineId", as: "line" });
TransportDisruption.belongsTo(Alert, { foreignKey: "alertId", as: "alert" });

export interface LineData {
  id: number;
  code: string;
  name: string;
  mode: TransportMode;
  color: string;
  stops: string[];
  zones: Zone[];
  frequencyMinutes: number | null;
  minutesBetweenStops: number;
  schedule: LineSchedule | null;
  accessible: boolean;
  notes: string | null;
}

export interface DisruptionData {
  id: number;
  line: LineData;
  alertId: number | null;
  kind: DisruptionKind;
  fromStop: string | null;
  toStop: string | null;
  reason: string;
  alternatives: Alternative[];
  status: "active" | "ended";
  startsAt: Date;
  expectedEndAt: Date | null;
  endedAt: Date | null;
  createdBy: number | null;
  updatedAt: Date | null;
}

const parseJsonArray = <T>(raw: string | null | undefined): T[] => {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

function parseSchedule(raw: string | null | undefined): LineSchedule | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && Array.isArray(value.days) && typeof value.first === "string" && typeof value.last === "string"
      ? { days: value.days, first: value.first, last: value.last, peaks: Array.isArray(value.peaks) ? value.peaks : [] }
      : null;
  } catch {
    return null;
  }
}

export function toLineData(line: TransportLine): LineData {
  return {
    id: line.id,
    code: line.code,
    name: line.name,
    mode: line.mode,
    color: line.color,
    stops: parseJsonArray<string>(line.stops),
    zones: line.zones.split(",").filter(Boolean) as Zone[],
    frequencyMinutes: line.frequencyMinutes ?? null,
    minutesBetweenStops: line.minutesBetweenStops ?? 3,
    schedule: parseSchedule(line.schedule),
    accessible: line.wheelchairAccessible ?? true,
    notes: line.notes ?? null,
  };
}

function toDisruptionData(row: TransportDisruption & { line?: TransportLine }): DisruptionData {
  return {
    id: row.id,
    line: toLineData(row.line!),
    alertId: row.alertId ?? null,
    kind: row.kind,
    fromStop: row.fromStop ?? null,
    toStop: row.toStop ?? null,
    reason: row.reason,
    alternatives: parseJsonArray<Alternative>(row.alternatives),
    status: row.status,
    startsAt: row.startsAt,
    expectedEndAt: row.expectedEndAt ?? null,
    endedAt: row.endedAt ?? null,
    createdBy: row.createdBy ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

const withLine = { model: TransportLine, as: "line" };

// Une interruption est « en cours » tant qu'elle n'est pas terminée. L'heure de reprise prévue est une information
// pour l'habitant, pas une fin automatique : la ligne n'est rétablie que lorsqu'un agent le confirme.
export const TransportModel = {
  async listLines(): Promise<LineData[]> {
    const lines = await TransportLine.findAll({ where: { active: true }, order: [["sortOrder", "ASC"], ["code", "ASC"]] });
    return lines.map(toLineData);
  },

  async findLinesByCodes(codes: string[]): Promise<Map<string, LineData>> {
    const lines = await TransportLine.findAll({ where: { code: codes, active: true } });
    return new Map(lines.map((line) => [line.code, toLineData(line)]));
  },

  async listActiveDisruptions(): Promise<DisruptionData[]> {
    const rows = await TransportDisruption.findAll({ where: { status: "active" }, include: [withLine], order: [["startsAt", "DESC"]] });
    return rows.map((row) => toDisruptionData(row as TransportDisruption & { line: TransportLine }));
  },

  async listDisruptions(filter: { status?: "active" | "ended"; limit: number; offset: number }) {
    const { rows, count } = await TransportDisruption.findAndCountAll({
      where: filter.status ? { status: filter.status } : {},
      include: [withLine],
      order: [["startsAt", "DESC"]],
      limit: filter.limit,
      offset: filter.offset,
    });
    return { disruptions: rows.map((row) => toDisruptionData(row as TransportDisruption & { line: TransportLine })), total: count };
  },

  async listByAlert(alertIds: number[]): Promise<DisruptionData[]> {
    if (!alertIds.length) return [];
    const rows = await TransportDisruption.findAll({ where: { alertId: { [Op.in]: alertIds } }, include: [withLine], order: [["id", "ASC"]] });
    return rows.map((row) => toDisruptionData(row as TransportDisruption & { line: TransportLine }));
  },

  async findById(id: number): Promise<DisruptionData | null> {
    const row = await TransportDisruption.findByPk(id, { include: [withLine] });
    return row ? toDisruptionData(row as TransportDisruption & { line: TransportLine }) : null;
  },

  async createMany(
    items: { lineId: number; kind: DisruptionKind; fromStop: string | null; toStop: string | null; alternatives: Alternative[] }[],
    shared: { reason: string; expectedEndAt: Date | null; createdBy: number }
  ): Promise<number[]> {
    return sequelize.transaction(async (transaction) => {
      const ids: number[] = [];
      for (const item of items) {
        const row = await TransportDisruption.create(
          { ...item, ...shared, alternatives: JSON.stringify(item.alternatives), status: "active" },
          { transaction }
        );
        ids.push(row.id);
      }
      return ids;
    });
  },

  async linkAlert(ids: number[], alertId: number) {
    await TransportDisruption.update({ alertId }, { where: { id: ids } });
  },

  async update(
    id: number,
    data: Partial<{ kind: DisruptionKind; fromStop: string | null; toStop: string | null; reason: string; alternatives: Alternative[]; expectedEndAt: Date | null }>
  ) {
    const { alternatives, ...rest } = data;
    await TransportDisruption.update(
      { ...rest, ...(alternatives ? { alternatives: JSON.stringify(alternatives) } : {}), updatedAt: new Date() },
      { where: { id } }
    );
  },

  async end(id: number) {
    const now = new Date();
    await TransportDisruption.update({ status: "ended", endedAt: now, updatedAt: now }, { where: { id, status: "active" } });
  },

  async countActiveForAlert(alertId: number): Promise<number> {
    return TransportDisruption.count({ where: { alertId, status: "active" } });
  },
};
