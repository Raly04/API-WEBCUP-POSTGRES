import {
  CreationOptional,
  DataTypes,
  IncludeOptions,
  InferAttributes,
  InferCreationAttributes,
  Model,
  NonAttribute,
} from "sequelize";
import sequelize from "../config/database";
import { PartnerService } from "./partnerService.model";
import { User } from "./user.model";

export const PARTNER_REQUEST_STATUSES = ["pending", "contacted", "closed"] as const;
export type PartnerRequestStatus = (typeof PARTNER_REQUEST_STATUSES)[number];

export function isPartnerRequestStatus(value: unknown): value is PartnerRequestStatus {
  return (PARTNER_REQUEST_STATUSES as readonly unknown[]).includes(value);
}

// ── Table partner_service_requests ───────────────────────────
// Demande de contact d'un habitant au sujet d'une offre partenaire : plus léger qu'une
// citizen_request (pas de priorité, pas d'historique), le partenaire se charge ensuite du suivi.
export class PartnerServiceRequest extends Model<
  InferAttributes<PartnerServiceRequest>,
  InferCreationAttributes<PartnerServiceRequest>
> {
  declare id: CreationOptional<number>;
  declare partnerServiceId: number;
  declare userId: number;
  declare message: CreationOptional<string | null>;
  declare status: CreationOptional<PartnerRequestStatus>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare service?: NonAttribute<Pick<PartnerService, "id" | "name" | "partnerId"> | null>;
  declare user?: NonAttribute<Pick<User, "id" | "firstName" | "lastName"> | null>;
}

PartnerServiceRequest.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    partnerServiceId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: PartnerService, key: "id" },
      onDelete: "CASCADE",
    },
    userId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: User, key: "id" },
      onDelete: "CASCADE",
    },
    message: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.ENUM(...PARTNER_REQUEST_STATUSES), allowNull: false, defaultValue: "pending" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "partner_service_requests", underscored: true }
);

PartnerServiceRequest.belongsTo(PartnerService, { foreignKey: "partnerServiceId", as: "service" });
PartnerServiceRequest.belongsTo(User, { foreignKey: "userId", as: "user" });

export type PartnerServiceRequestData = InferAttributes<PartnerServiceRequest> & {
  service?: Pick<PartnerService, "id" | "name" | "partnerId"> | null;
  user?: Pick<User, "id" | "firstName" | "lastName"> | null;
};

const withRelations: IncludeOptions[] = [
  { model: PartnerService, as: "service", attributes: ["id", "name", "partnerId"] },
  { model: User, as: "user", attributes: ["id", "firstName", "lastName"] },
];

const plain = (row: PartnerServiceRequest | null) => (row?.get({ plain: true }) as PartnerServiceRequestData) ?? null;

// ── Accès aux données ────────────────────────────────────────
export const PartnerServiceRequestModel = {
  async create(data: { partnerServiceId: number; userId: number; message: string | null }): Promise<PartnerServiceRequestData> {
    const created = await PartnerServiceRequest.create({ ...data, status: "pending" });
    return (await PartnerServiceRequestModel.findById(created.id))!;
  },

  async findById(id: number): Promise<PartnerServiceRequestData | null> {
    return plain(await PartnerServiceRequest.findByPk(id, { include: withRelations }));
  },

  // Réservé au tableau de bord du partenaire : les demandes de TOUTES ses offres, via une jointure
  // sur partner_services plutôt qu'un filtre applicatif après coup
  async listByPartner(partnerId: number): Promise<PartnerServiceRequestData[]> {
    const rows = await PartnerServiceRequest.findAll({
      include: [
        { model: PartnerService, as: "service", attributes: ["id", "name", "partnerId"], where: { partnerId } },
        { model: User, as: "user", attributes: ["id", "firstName", "lastName"] },
      ],
      order: [["createdAt", "DESC"]],
    });
    return rows.map((row) => row.get({ plain: true }) as PartnerServiceRequestData);
  },

  // Demande appartenant bien à une offre de ce partenaire : critère de recherche, pas une
  // vérification après coup (même logique que CitizenRequestModel.findOwnedById)
  async findOwnedByPartner(id: number, partnerId: number): Promise<PartnerServiceRequestData | null> {
    return plain(
      await PartnerServiceRequest.findOne({
        where: { id },
        include: [
          { model: PartnerService, as: "service", attributes: ["id", "name", "partnerId"], where: { partnerId } },
          { model: User, as: "user", attributes: ["id", "firstName", "lastName"] },
        ],
      })
    );
  },

  async setStatus(id: number, status: PartnerRequestStatus): Promise<PartnerServiceRequestData | null> {
    const [count] = await PartnerServiceRequest.update({ status }, { where: { id } });
    return count > 0 ? PartnerServiceRequestModel.findById(id) : null;
  },
};
