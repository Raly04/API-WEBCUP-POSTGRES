import { CreationOptional, DataTypes, IncludeOptions, InferAttributes, InferCreationAttributes, Model, NonAttribute } from "sequelize";
import sequelize from "../config/database";
import { User } from "./user.model";

export const NEXT_ACTION_TYPES = ["phone", "email", "visit", "link"] as const;
export type NextActionType = (typeof NEXT_ACTION_TYPES)[number];

export function isNextActionType(value: unknown): value is NextActionType {
  return (NEXT_ACTION_TYPES as readonly unknown[]).includes(value);
}

// ── Table partner_services ───────────────────────────────────
// Offre d'un partenaire extérieur (entreprise, association...) proposée aux habitants.
// isAvailable distingue "ce qui est disponible" de "ce qui ne l'est pas" ; nextAction* porte
// la prochaine action possible (appeler, réserver, se présenter...), affichée directement sur
// la fiche pour que l'habitant agisse sans naviguer plusieurs écrans.
export class PartnerService extends Model<InferAttributes<PartnerService>, InferCreationAttributes<PartnerService>> {
  declare id: CreationOptional<number>;
  declare partnerId: number;
  declare name: string;
  declare description: CreationOptional<string | null>;
  declare category: CreationOptional<string | null>;
  declare address: CreationOptional<string | null>;
  declare openingHours: CreationOptional<string | null>;
  declare contactPhone: CreationOptional<string | null>;
  declare contactEmail: CreationOptional<string | null>;
  declare isAvailable: CreationOptional<boolean>;
  declare availabilityNote: CreationOptional<string | null>;
  declare nextActionLabel: CreationOptional<string | null>;
  declare nextActionType: CreationOptional<NextActionType | null>;
  declare nextActionValue: CreationOptional<string | null>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare partner?: NonAttribute<Pick<User, "id" | "firstName" | "lastName"> | null>;
}

PartnerService.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    partnerId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: User, key: "id" },
      onDelete: "CASCADE",
    },
    name: { type: DataTypes.STRING(150), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    category: { type: DataTypes.STRING(100), allowNull: true },
    address: { type: DataTypes.STRING(255), allowNull: true },
    openingHours: { type: DataTypes.STRING(255), allowNull: true },
    contactPhone: { type: DataTypes.STRING(30), allowNull: true },
    contactEmail: { type: DataTypes.STRING(255), allowNull: true },
    isAvailable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    availabilityNote: { type: DataTypes.STRING(255), allowNull: true },
    nextActionLabel: { type: DataTypes.STRING(100), allowNull: true },
    nextActionType: { type: DataTypes.ENUM(...NEXT_ACTION_TYPES), allowNull: true },
    nextActionValue: { type: DataTypes.STRING(255), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "partner_services", underscored: true }
);

PartnerService.belongsTo(User, { foreignKey: "partnerId", as: "partner" });

export type PartnerServiceData = InferAttributes<PartnerService> & {
  partner?: Pick<User, "id" | "firstName" | "lastName"> | null;
};

export type PartnerServiceInput = {
  name: string;
  description?: string | null;
  category?: string | null;
  address?: string | null;
  openingHours?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  isAvailable?: boolean;
  availabilityNote?: string | null;
  nextActionLabel?: string | null;
  nextActionType?: NextActionType | null;
  nextActionValue?: string | null;
  isActive?: boolean;
};
export type PartnerServiceUpdate = Partial<PartnerServiceInput>;

const withPartner: IncludeOptions = { model: User, as: "partner", attributes: ["id", "firstName", "lastName"] };

const plain = (row: PartnerService | null) => (row?.get({ plain: true }) as PartnerServiceData) ?? null;

// ── Accès aux données ────────────────────────────────────────
export const PartnerServiceModel = {
  // Catalogue vu par les habitants : actif uniquement, les plus récents d'abord
  async list(options: { includeInactive: boolean }): Promise<PartnerServiceData[]> {
    const services = await PartnerService.findAll({
      where: options.includeInactive ? {} : { isActive: true },
      include: [withPartner],
      order: [["createdAt", "DESC"]],
    });
    return services.map((service) => service.get({ plain: true }) as PartnerServiceData);
  },

  async listByPartner(partnerId: number): Promise<PartnerServiceData[]> {
    const services = await PartnerService.findAll({
      where: { partnerId },
      order: [["createdAt", "DESC"]],
    });
    return services.map((service) => service.get({ plain: true }) as PartnerServiceData);
  },

  async findById(id: number): Promise<PartnerServiceData | null> {
    return plain(await PartnerService.findByPk(id, { include: [withPartner] }));
  },

  async create(partnerId: number, data: PartnerServiceInput): Promise<PartnerServiceData> {
    const created = await PartnerService.create({ ...data, partnerId });
    return (await PartnerServiceModel.findById(created.id))!;
  },

  async update(id: number, data: PartnerServiceUpdate): Promise<PartnerServiceData | null> {
    const service = await PartnerService.findByPk(id);
    if (!service) return null;
    await service.update(data);
    return PartnerServiceModel.findById(id);
  },

  async delete(id: number): Promise<boolean> {
    return (await PartnerService.destroy({ where: { id } })) > 0;
  },
};
