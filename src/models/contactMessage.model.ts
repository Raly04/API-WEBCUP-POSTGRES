import {
  CreationOptional,
  DataTypes,
  IncludeOptions,
  InferAttributes,
  InferCreationAttributes,
  Model,
  NonAttribute,
  Op,
} from "sequelize";
import sequelize from "../config/database";
import { enumRankQuoted } from "../utils/sql";
import { User } from "./user.model";

export const CONTACT_STATUSES = ["new", "read", "processed"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

// ── Table contact_messages ───────────────────────────────────
export class ContactMessage extends Model<InferAttributes<ContactMessage>, InferCreationAttributes<ContactMessage>> {
  declare id: CreationOptional<number>;
  declare userId: CreationOptional<number | null>;
  declare subject: string;
  declare message: string;
  declare status: CreationOptional<ContactStatus>;
  declare sentAt: CreationOptional<Date>;
  declare confirmedAt: CreationOptional<Date | null>;
  declare sender?: NonAttribute<Pick<User, "id" | "email" | "firstName" | "lastName"> | null>;
}

ContactMessage.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    subject: { type: DataTypes.STRING(255), allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: false },
    status: { type: DataTypes.ENUM(...CONTACT_STATUSES), allowNull: false, defaultValue: "new" },
    sentAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    confirmedAt: { type: DataTypes.DATE, allowNull: true },
  },
  // Seulement sent_at / confirmed_at : pas de created_at / updated_at dans cette table
  { sequelize, tableName: "contact_messages", timestamps: false }
);

// Expéditeur affiché aux agents (null si le compte a été supprimé : FK ON DELETE SET NULL)
ContactMessage.belongsTo(User, { foreignKey: "userId", as: "sender" });

export type ContactMessageData = InferAttributes<ContactMessage> & {
  sender?: { id: number; email: string; firstName: string; lastName: string } | null;
};

const withSender: IncludeOptions = { model: User, as: "sender", attributes: ["id", "email", "firstName", "lastName"] };

// ── Accès aux données ────────────────────────────────────────
export const ContactMessageModel = {
  // L'accusé de réception (confirmed_at) est posé dès l'enregistrement : le serveur a bien reçu le message
  async create(data: { userId: number; subject: string; message: string }): Promise<ContactMessageData> {
    const now = new Date();
    const created = await ContactMessage.create({ ...data, sentAt: now, confirmedAt: now });
    return created.get({ plain: true });
  },

  async findById(id: number): Promise<ContactMessageData | null> {
    const message = await ContactMessage.findByPk(id, { include: [withSender] });
    return (message?.get({ plain: true }) as ContactMessageData | undefined) ?? null;
  },

  async listForUser(userId: number): Promise<ContactMessageData[]> {
    const messages = await ContactMessage.findAll({ where: { userId }, order: [["sentAt", "DESC"], ["id", "DESC"]] });
    return messages.map((message) => message.get({ plain: true }));
  },

  // Boîte de réception des agents : les nouveaux d'abord, puis les plus récents
  async listInbox(options: { status?: ContactStatus; search?: string; limit: number; offset: number }) {
    const where: Record<string | symbol, unknown> = {};
    if (options.status) where.status = options.status;
    if (options.search) {
      where[Op.or] = [
        { subject: { [Op.iLike]: `%${options.search}%` } },
        { message: { [Op.iLike]: `%${options.search}%` } },
      ];
    }
    const { rows, count } = await ContactMessage.findAndCountAll({
      where,
      include: [withSender],
      order: [
        [sequelize.literal(enumRankQuoted('"ContactMessage"."status"', ["new", "read", "processed"])), "ASC"],
        ["sentAt", "DESC"],
        ["id", "DESC"],
      ],
      limit: options.limit,
      offset: options.offset,
      distinct: true,
    });
    return { messages: rows.map((row) => row.get({ plain: true }) as ContactMessageData), total: count };
  },

  async updateStatus(id: number, status: ContactStatus): Promise<ContactMessageData | null> {
    const [count] = await ContactMessage.update({ status }, { where: { id } });
    // count vaut 0 si le statut était déjà identique : on vérifie l'existence séparément
    return count > 0 || (await ContactMessage.count({ where: { id } })) > 0 ? ContactMessageModel.findById(id) : null;
  },

  // Compteurs par statut pour le tableau de bord agent
  async countByStatus(): Promise<Record<ContactStatus, number>> {
    const rows = (await ContactMessage.findAll({
      attributes: ["status", [sequelize.fn("COUNT", sequelize.col("id")), "total"]],
      group: ["status"],
      raw: true,
    })) as unknown as { status: ContactStatus; total: number }[];
    const counts: Record<ContactStatus, number> = { new: 0, read: 0, processed: 0 };
    for (const row of rows) counts[row.status] = Number(row.total);
    return counts;
  },
};
