import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model } from "sequelize";
import sequelize from "../config/database";

// ── Table external_entities ───────────────────────────────────
// Entités hors plateforme (entreprise, association, groupe...) associées à un projet.
// Créées à la volée ("ajout rapide") par un administrateur depuis le formulaire projet.
export class ExternalEntity extends Model<InferAttributes<ExternalEntity>, InferCreationAttributes<ExternalEntity>> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare type: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

ExternalEntity.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(150), allowNull: false },
    type: { type: DataTypes.STRING(100), allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "external_entities", underscored: true }
);

export type ExternalEntityData = InferAttributes<ExternalEntity>;

export const ExternalEntityModel = {
  async list(): Promise<ExternalEntityData[]> {
    const rows = await ExternalEntity.findAll({ order: [["name", "ASC"]] });
    return rows.map((row) => row.get({ plain: true }));
  },

  async findById(id: number): Promise<ExternalEntityData | null> {
    const row = await ExternalEntity.findByPk(id);
    return row?.get({ plain: true }) ?? null;
  },

  // Idempotent sur le nom (insensible à la casse) : un "ajout rapide" répété ne duplique rien
  async findOrCreate(name: string, type: string | null): Promise<ExternalEntityData> {
    const existing = await ExternalEntity.findOne({ where: { name } });
    if (existing) return existing.get({ plain: true });
    return (await ExternalEntity.create({ name, type })).get({ plain: true });
  },

  async delete(id: number): Promise<boolean> {
    return (await ExternalEntity.destroy({ where: { id } })) > 0;
  },
};
