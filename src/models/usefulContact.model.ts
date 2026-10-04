import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model, Op } from "sequelize";
import sequelize from "../config/database";
import { enumRank } from "../utils/sql";
import type { Zone } from "./alert.model";
import { MunicipalService } from "./municipalService.model";

// Coordonnées utiles : qui appeler, où aller. Numéros de crise, centre médical, abris, points de rassemblement, points
// d'eau potable, dépannage... Tenues à jour par le personnel, y compris PENDANT une crise (un abri qui ouvre, qui est
// complet). Lisibles sans compte, et gardées en copie de secours pour rester consultables pendant une panne.

// Dans l'ordre où une personne en difficulté les cherche
export const CONTACT_CATEGORIES = ["emergency", "crisis", "health", "shelter", "water", "utilities", "transport", "city", "other"] as const;
export type ContactCategory = (typeof CONTACT_CATEGORIES)[number];
export const CATEGORY_LABELS: Record<ContactCategory, { fr: string; en: string }> = {
  emergency: { fr: "Urgences", en: "Emergency" },
  crisis: { fr: "Cellule de crise", en: "Crisis unit" },
  health: { fr: "Santé", en: "Health" },
  shelter: { fr: "Abris et points de rassemblement", en: "Shelters and assembly points" },
  water: { fr: "Eau potable", en: "Drinking water" },
  utilities: { fr: "Dépannage eau et énergie", en: "Water and power repairs" },
  transport: { fr: "Transports", en: "Transport" },
  city: { fr: "Mairie et accueil", en: "City hall and reception" },
  other: { fr: "Autres contacts", en: "Other contacts" },
};
export const isContactCategory = (value: unknown): value is ContactCategory => (CONTACT_CATEGORIES as readonly unknown[]).includes(value);

export class UsefulContact extends Model<InferAttributes<UsefulContact>, InferCreationAttributes<UsefulContact>> {
  declare id: CreationOptional<number>;
  declare label: string;
  declare category: ContactCategory;
  declare phone: CreationOptional<string | null>;
  declare email: CreationOptional<string | null>;
  declare address: CreationOptional<string | null>;
  declare zone: CreationOptional<Zone | null>; // null : toute la ville
  declare openingHours: CreationOptional<string | null>;
  declare available24h: CreationOptional<boolean>;
  declare description: CreationOptional<string | null>;
  declare isOpen: CreationOptional<boolean>; // un lieu (abri, point d'eau) ouvert en ce moment ?
  declare statusNote: CreationOptional<string | null>; // « Complet », « 80 places libres »...
  declare serviceId: CreationOptional<number | null>;
  declare sortOrder: CreationOptional<number>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date | null>;
}

UsefulContact.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    label: { type: DataTypes.STRING(150), allowNull: false },
    category: { type: DataTypes.ENUM(...CONTACT_CATEGORIES), allowNull: false },
    phone: { type: DataTypes.STRING(30), allowNull: true },
    email: { type: DataTypes.STRING(150), allowNull: true },
    address: { type: DataTypes.STRING(255), allowNull: true },
    zone: { type: DataTypes.STRING(20), allowNull: true },
    openingHours: { type: DataTypes.STRING(150), allowNull: true },
    available24h: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "available_24h" },
    description: { type: DataTypes.STRING(300), allowNull: true },
    isOpen: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    statusNote: { type: DataTypes.STRING(255), allowNull: true },
    serviceId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: "useful_contacts", underscored: true }
);

UsefulContact.belongsTo(MunicipalService, { foreignKey: "serviceId", as: "service" });

export type UsefulContactData = InferAttributes<UsefulContact>;
export type UsefulContactInput = Omit<UsefulContactData, "id" | "createdAt" | "updatedAt">;

const CATEGORY_ORDER = sequelize.literal(enumRank("category", CONTACT_CATEGORIES));
const plain = (row: UsefulContact | null) => (row ? (row.get({ plain: true }) as UsefulContactData) : null);

export const UsefulContactModel = {
  // Publique : contacts actifs de toute la ville et, si un quartier est donné, ceux de ce quartier
  async listPublic(zone?: Zone): Promise<UsefulContactData[]> {
    const rows = await UsefulContact.findAll({
      where: { isActive: true, ...(zone ? { [Op.or]: [{ zone: null }, { zone }] } : {}) },
      order: [[CATEGORY_ORDER, "ASC"], ["sortOrder", "ASC"], ["label", "ASC"]],
    });
    return rows.map((row) => row.get({ plain: true }) as UsefulContactData);
  },

  async listAll(): Promise<UsefulContactData[]> {
    const rows = await UsefulContact.findAll({ order: [[CATEGORY_ORDER, "ASC"], ["sortOrder", "ASC"], ["label", "ASC"]] });
    return rows.map((row) => row.get({ plain: true }) as UsefulContactData);
  },

  async findById(id: number): Promise<UsefulContactData | null> {
    return plain(await UsefulContact.findByPk(id));
  },

  async create(data: Partial<UsefulContactInput> & Pick<UsefulContactInput, "label" | "category">): Promise<UsefulContactData> {
    const created = await UsefulContact.create(data);
    return (await UsefulContactModel.findById(created.id))!;
  },

  async update(id: number, data: Partial<UsefulContactInput>): Promise<UsefulContactData | null> {
    const row = await UsefulContact.findByPk(id);
    if (!row) return null;
    await row.update({ ...data, updatedAt: new Date() });
    return UsefulContactModel.findById(id);
  },

  async delete(id: number): Promise<boolean> {
    return (await UsefulContact.destroy({ where: { id } })) > 0;
  },

  async count(): Promise<number> {
    return UsefulContact.count();
  },
};
