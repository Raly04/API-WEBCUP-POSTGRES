import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model, NonAttribute } from "sequelize";
import sequelize from "../config/database";
import { CitizenRequest } from "./citizenRequest.model";
import { MunicipalService } from "./municipalService.model";
import { User } from "./user.model";

// Qui a produit l'orientation. "fallback" n'est pas une erreur : c'est le routage par mots-clés
// qui garantit une réponse quand le modèle est indisponible. La colonne sert à mesurer le taux
// de repli plutôt que de le masquer.
export const GUIDANCE_SOURCES = ["llm", "fallback"] as const;
export type GuidanceSource = (typeof GUIDANCE_SOURCES)[number];

export function isGuidanceSource(value: unknown): value is GuidanceSource {
  return (GUIDANCE_SOURCES as readonly unknown[]).includes(value);
}

// Une démarche tient en quelques étapes courtes : au-delà, l'habitant ne la lit pas jusqu'au bout
export const MAX_GUIDANCE_STEPS = 6;

// ── Table guidance_requests ──────────────────────────────────
// Une demande d'orientation : l'habitant décrit un problème, la ville répond par le service
// compétent et la démarche à suivre. Distincte d'une citizen_request, qui est le dossier déposé
// auprès du service une fois l'orientation connue.
export class GuidanceRequest extends Model<
  InferAttributes<GuidanceRequest>,
  InferCreationAttributes<GuidanceRequest>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare problem: string;
  declare serviceId: CreationOptional<number | null>;
  declare summary: CreationOptional<string | null>;
  declare steps: CreationOptional<string[] | null>;
  declare source: GuidanceSource;
  declare model: CreationOptional<string | null>;
  declare requestId: CreationOptional<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare service?: NonAttribute<Pick<MunicipalService, "id" | "code" | "name">> | null;
  declare request?: NonAttribute<Pick<CitizenRequest, "id" | "subject" | "createdAt">> | null;
  declare author?: NonAttribute<Pick<User, "id" | "firstName" | "lastName">> | null;
}

GuidanceRequest.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: User, key: "id" },
      onDelete: "CASCADE",
    },
    problem: { type: DataTypes.TEXT, allowNull: false },
    serviceId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    summary: { type: DataTypes.TEXT, allowNull: true },
    steps: { type: DataTypes.JSON, allowNull: true },
    source: { type: DataTypes.ENUM(...GUIDANCE_SOURCES), allowNull: false },
    model: { type: DataTypes.STRING(60), allowNull: true },
    requestId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "guidance_requests", underscored: true, timestamps: false }
);

// Le service proposé peut être désactivé ou supprimé par un administrateur après coup :
// SET NULL laisse la trace de la demande d'orientation sans la faire disparaître.
GuidanceRequest.belongsTo(MunicipalService, { foreignKey: "serviceId", as: "service" });
GuidanceRequest.belongsTo(CitizenRequest, { foreignKey: "requestId", as: "request" });
GuidanceRequest.belongsTo(User, { foreignKey: "userId", as: "author" });

export type GuidanceRequestData = InferAttributes<GuidanceRequest> & {
  service?: { id: number; code: string; name: string } | null;
  request?: { id: number; subject: string; createdAt: Date } | null;
  author?: { id: number; firstName: string; lastName: string } | null;
};

// Un habitant ne consulte que ses propres orientations : le filtre porte sur userId, comme pour les demandes
export const GUIDANCE_INCLUDE = [
  { model: MunicipalService, as: "service", attributes: ["id", "code", "name"] },
  // createdAt compris : l'habitant doit pouvoir dater sa demande, pas seulement la reconnaître
  { model: CitizenRequest, as: "request", attributes: ["id", "subject", "createdAt"] },
];

export const GUIDANCE_STAFF_INCLUDE = [
  ...GUIDANCE_INCLUDE,
  { model: User, as: "author", attributes: ["id", "firstName", "lastName"] },
];

// ── Accès aux données ────────────────────────────────────────
export const GuidanceRequestModel = {
  async create(data: {
    userId: number;
    problem: string;
    serviceId: number | null;
    summary: string | null;
    steps: string[] | null;
    source: GuidanceSource;
    model: string | null;
  }): Promise<GuidanceRequestData> {
    const created = await GuidanceRequest.create(data);
    return (await GuidanceRequestModel.findById(created.id))!;
  },

  async findById(id: number): Promise<GuidanceRequestData | null> {
    const row = await GuidanceRequest.findByPk(id, { include: [...GUIDANCE_INCLUDE] });
    return row?.get({ plain: true }) ?? null;
  },

  // Une orientation appartient à son auteur : userId est une condition, pas un filtre optionnel
  async findOwnedBy(id: number, userId: number): Promise<GuidanceRequestData | null> {
    const row = await GuidanceRequest.findOne({ where: { id, userId }, include: [...GUIDANCE_INCLUDE] });
    return row?.get({ plain: true }) ?? null;
  },

  // Rattache la demande déposée à l'orientation qui l'a produite : le dépôt n'a lieu qu'une fois
  async attachRequest(id: number, userId: number, requestId: number): Promise<GuidanceRequestData | null> {
    const [count] = await GuidanceRequest.update({ requestId }, { where: { id, userId } });
    return count > 0 ? GuidanceRequestModel.findById(id) : null;
  },

  // File des orientations pour l'administration, la plus récente d'abord
  async listAll(options: { limit: number; offset: number }) {
    const { rows, count } = await GuidanceRequest.findAndCountAll({
      include: [...GUIDANCE_STAFF_INCLUDE],
      order: [["createdAt", "DESC"], ["id", "DESC"]],
      limit: options.limit,
      offset: options.offset,
    });
    return {
      guidance: rows.map((row) => row.get({ plain: true }) as GuidanceRequestData),
      total: count,
    };
  },
};