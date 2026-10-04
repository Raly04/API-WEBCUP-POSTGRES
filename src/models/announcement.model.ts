import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  IncludeOptions,
  InferCreationAttributes,
  Model,
  NonAttribute,
  Op,
} from "sequelize";
import sequelize from "../config/database";
import { User } from "./user.model";

export const ANNOUNCEMENT_STATUSES = ["draft", "published", "archived"] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

// Priorité d'une annonce : default = page d'actualités seule, medium = alerte jaune à la
// publication, max = alerte rouge réservée aux annonces du Haut Conseil.
export const ANNOUNCEMENT_PRIORITIES = ["default", "medium", "max"] as const;
export type AnnouncementPriority = (typeof ANNOUNCEMENT_PRIORITIES)[number];

// ── Table announcements ──────────────────────────────────────
export class Announcement extends Model<InferAttributes<Announcement>, InferCreationAttributes<Announcement>> {
  declare id: CreationOptional<number>;
  declare title: string;
  declare content: string;
  declare status: CreationOptional<AnnouncementStatus>;
  declare priority: CreationOptional<AnnouncementPriority>;
  declare authorId: CreationOptional<number | null>;
  declare publishedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare author?: NonAttribute<Pick<User, "id" | "firstName" | "lastName"> | null>;
}

Announcement.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    title: { type: DataTypes.STRING(255), allowNull: false },
    content: { type: DataTypes.TEXT, allowNull: false },
    status: { type: DataTypes.ENUM(...ANNOUNCEMENT_STATUSES), allowNull: false, defaultValue: "draft" },
    priority: { type: DataTypes.ENUM(...ANNOUNCEMENT_PRIORITIES), allowNull: false, defaultValue: "default" },
    authorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    publishedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "announcements" }
);

// Auteur affiché avec l'annonce (jamais l'email ni le hash)
Announcement.belongsTo(User, { foreignKey: "authorId", as: "author" });

export type AnnouncementData = InferAttributes<Announcement> & {
  author?: { id: number; firstName: string; lastName: string } | null;
};
export type AnnouncementUpdate = Partial<{
  title: string;
  content: string;
  status: AnnouncementStatus;
  priority: AnnouncementPriority;
  publishedAt: Date | null;
}>;

const withAuthor: IncludeOptions = { model: User, as: "author", attributes: ["id", "firstName", "lastName"] };

// ── Accès aux données ────────────────────────────────────────
export const AnnouncementModel = {
  async list(options: { statuses: AnnouncementStatus[]; search?: string; limit: number; offset: number }) {
    const where: Record<string | symbol, unknown> = { status: { [Op.in]: options.statuses } };
    if (options.search) {
      where[Op.or] = [
        { title: { [Op.iLike]: `%${options.search}%` } },
        { content: { [Op.iLike]: `%${options.search}%` } },
      ];
    }
    const { rows, count } = await Announcement.findAndCountAll({
      where,
      include: [withAuthor],
      // Les plus récemment publiées d'abord ; les brouillons (sans date) selon leur création
      order: [
        [sequelize.fn("COALESCE", sequelize.col("Announcement.published_at"), sequelize.col("Announcement.created_at")), "DESC"],
        ["id", "DESC"],
      ],
      limit: options.limit,
      offset: options.offset,
      distinct: true,
    });
    return { announcements: rows.map((row) => row.get({ plain: true }) as AnnouncementData), total: count };
  },

  async findById(id: number): Promise<AnnouncementData | null> {
    const announcement = await Announcement.findByPk(id, { include: [withAuthor] });
    return (announcement?.get({ plain: true }) as AnnouncementData | undefined) ?? null;
  },

  async create(data: {
    title: string;
    content: string;
    status: AnnouncementStatus;
    priority: AnnouncementPriority;
    authorId: number;
  }) {
    const publishedAt = data.status === "published" ? new Date() : null;
    const created = await Announcement.create({ ...data, publishedAt });
    return (await AnnouncementModel.findById(created.id))!;
  },

  async update(id: number, data: AnnouncementUpdate): Promise<AnnouncementData | null> {
    const announcement = await Announcement.findByPk(id);
    if (!announcement) return null;
    await announcement.update(data);
    return AnnouncementModel.findById(id);
  },

  async delete(id: number): Promise<boolean> {
    return (await Announcement.destroy({ where: { id } })) > 0;
  },
};
