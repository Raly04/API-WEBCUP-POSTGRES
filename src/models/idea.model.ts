import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model } from "sequelize";
import sequelize from "../config/database";
import { User } from "./user.model";

// ── Table ideas ───────────────────────────────────────────────
// Une idée = un texte libre déposé par un habitant pour améliorer la ville.
// Aucun statut : les idées sont lues par les administrateurs, pas traitées dans un workflow.
// Les objets métier qu'elle référence vivent dans idea_mentions (voir ideaMention.model.ts).
export class Idea extends Model<InferAttributes<Idea>, InferCreationAttributes<Idea>> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare content: string;
  declare createdAt: CreationOptional<Date>;
  declare author?: { id: number; firstName: string; lastName: string } | null;
}

Idea.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: User, key: "id" },
      onDelete: "CASCADE",
    },
    content: { type: DataTypes.TEXT, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "ideas", underscored: true, timestamps: false }
);

// Auteur affiché aux administrateurs (la FKON DELETE CASCADE emporte déjà la ligne)
Idea.belongsTo(User, { foreignKey: "userId", as: "author" });

export type IdeaData = InferAttributes<Idea> & {
  author?: { id: number; firstName: string; lastName: string } | null;
};

// ── Accès aux données ────────────────────────────────────────
export const IdeaModel = {
  async create(data: { userId: number; content: string }): Promise<IdeaData> {
    const created = await Idea.create(data);
    return created.get({ plain: true });
  },

  // File des idées pour les administrateurs, la plus récente d'abord
  async listAll(options: { limit: number; offset: number }) {
    const { rows, count } = await Idea.findAndCountAll({
      include: [{ model: User, as: "author", attributes: ["id", "firstName", "lastName"] }],
      order: [["createdAt", "DESC"], ["id", "DESC"]],
      limit: options.limit,
      offset: options.offset,
    });
    return { ideas: rows.map((row) => row.get({ plain: true }) as IdeaData), total: count };
  },
};