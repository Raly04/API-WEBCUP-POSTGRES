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
import { MunicipalService } from "./municipalService.model";

// ── Table establishments ─────────────────────────────────────
export class Establishment extends Model<InferAttributes<Establishment>, InferCreationAttributes<Establishment>> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare serviceId: CreationOptional<number | null>;
  declare description: CreationOptional<string | null>;
  declare address: string;
  declare isOpen: CreationOptional<boolean>;
  declare statusNote: CreationOptional<string | null>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare service?: NonAttribute<Pick<MunicipalService, "id" | "code" | "name" | "icon"> | null>;
}

Establishment.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(150), allowNull: false },
    serviceId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: MunicipalService, key: "id" },
      onDelete: "SET NULL",
    },
    description: { type: DataTypes.TEXT, allowNull: true },
    address: { type: DataTypes.STRING(255), allowNull: false },
    isOpen: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    statusNote: { type: DataTypes.STRING(255), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "establishments", underscored: true }
);

Establishment.belongsTo(MunicipalService, { foreignKey: "serviceId", as: "service" });

export type EstablishmentData = InferAttributes<Establishment> & {
  service?: Pick<MunicipalService, "id" | "code" | "name" | "icon"> | null;
};
export type EstablishmentInput = {
  name: string;
  serviceId: number | null;
  description?: string | null;
  address: string;
  isOpen?: boolean;
  statusNote?: string | null;
  isActive?: boolean;
};
export type EstablishmentUpdate = Partial<EstablishmentInput>;

const withService: IncludeOptions = { model: MunicipalService, as: "service", attributes: ["id", "code", "name", "icon"] };

const plain = (row: Establishment | null) => (row?.get({ plain: true }) as EstablishmentData) ?? null;

// ── Accès aux données ────────────────────────────────────────
export const EstablishmentModel = {
  // Ordre d'affichage : nom
  async list(options: { includeInactive: boolean }): Promise<EstablishmentData[]> {
    const establishments = await Establishment.findAll({
      where: options.includeInactive ? {} : { isActive: true },
      include: [withService],
      order: [["name", "ASC"]],
    });
    return establishments.map((establishment) => establishment.get({ plain: true }) as EstablishmentData);
  },

  async findById(id: number): Promise<EstablishmentData | null> {
    return plain(await Establishment.findByPk(id, { include: [withService] }));
  },

  async create(data: EstablishmentInput): Promise<EstablishmentData> {
    const created = await Establishment.create(data);
    return (await EstablishmentModel.findById(created.id))!;
  },

  async update(id: number, data: EstablishmentUpdate): Promise<EstablishmentData | null> {
    const establishment = await Establishment.findByPk(id);
    if (!establishment) return null;
    await establishment.update(data);
    return EstablishmentModel.findById(id);
  },

  async delete(id: number): Promise<boolean> {
    return (await Establishment.destroy({ where: { id } })) > 0;
  },
};
