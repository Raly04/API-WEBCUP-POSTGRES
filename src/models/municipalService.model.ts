import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model } from "sequelize";
import sequelize from "../config/database";

// ── Table municipal_services ─────────────────────────────────
export class MunicipalService extends Model<InferAttributes<MunicipalService>, InferCreationAttributes<MunicipalService>> {
  declare id: CreationOptional<number>;
  declare code: string;
  declare name: string;
  declare description: CreationOptional<string | null>;
  declare icon: CreationOptional<string | null>;
  declare isActive: CreationOptional<boolean>;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

MunicipalService.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    code: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(150), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    icon: { type: DataTypes.STRING(255), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // createdAt/updatedAt portent une valeur par défaut explicite : MySQL remplissait
    // implicitement une colonne TIMESTAMP NOT NULL, PostgreSQL non (la colonne doit être
    // NOT NULL sans DEFAULT, l'INSERT direct échoue). La table est créée par sequelize.sync()
    // (bloc 1) alors que le DDL du bloc 3 la décrit aussi : les deux doivent coïncider.
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
  },
  { sequelize, tableName: "municipal_services" }
);

export type MunicipalServiceData = InferAttributes<MunicipalService>;
export type MunicipalServiceInput = {
  code: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  isActive?: boolean;
  sortOrder?: number;
};
export type MunicipalServiceUpdate = Partial<Omit<MunicipalServiceInput, "code">>;

// ── Accès aux données ────────────────────────────────────────
export const MunicipalServiceModel = {
  // Ordre d'affichage : sort_order puis nom
  async list(options: { includeInactive: boolean }): Promise<MunicipalServiceData[]> {
    const services = await MunicipalService.findAll({
      where: options.includeInactive ? {} : { isActive: true },
      order: [["sortOrder", "ASC"], ["name", "ASC"]],
    });
    return services.map((service) => service.get({ plain: true }));
  },

  async findById(id: number): Promise<MunicipalServiceData | null> {
    const service = await MunicipalService.findByPk(id);
    return service?.get({ plain: true }) ?? null;
  },

  async findByCode(code: string): Promise<MunicipalServiceData | null> {
    const service = await MunicipalService.findOne({ where: { code } });
    return service?.get({ plain: true }) ?? null;
  },

  async create(data: MunicipalServiceInput): Promise<MunicipalServiceData> {
    return (await MunicipalService.create(data)).get({ plain: true });
  },

  async update(id: number, data: MunicipalServiceUpdate): Promise<MunicipalServiceData | null> {
    const service = await MunicipalService.findByPk(id);
    return service ? (await service.update(data)).get({ plain: true }) : null;
  },

  async delete(id: number): Promise<boolean> {
    return (await MunicipalService.destroy({ where: { id } })) > 0;
  },
};
