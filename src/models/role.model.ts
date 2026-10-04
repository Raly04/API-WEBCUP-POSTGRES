import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model, QueryTypes } from "sequelize";
import sequelize from "../config/database";

// ── Table roles ──────────────────────────────────────────────
export class Role extends Model<InferAttributes<Role>, InferCreationAttributes<Role>> {
  declare id: CreationOptional<number>;
  declare code: string;
  declare label: string;
  declare level: CreationOptional<number>;
  declare isSystem: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Role.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    code: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    label: { type: DataTypes.STRING(100), allowNull: false },
    level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "roles" }
);

export type RoleData = InferAttributes<Role>;
export type RoleInput = { code: string; label: string; level?: number };
export type RoleUpdate = Partial<Pick<RoleData, "label" | "level">>;

// ── Accès aux données ────────────────────────────────────────
export const RoleModel = {
  async list(): Promise<RoleData[]> {
    const roles = await Role.findAll({ order: [["level", "ASC"], ["id", "ASC"]] });
    return roles.map((role) => role.get({ plain: true }));
  },

  async findById(id: number): Promise<RoleData | null> {
    const role = await Role.findByPk(id);
    return role?.get({ plain: true }) ?? null;
  },

  async findByCode(code: string): Promise<RoleData | null> {
    const role = await Role.findOne({ where: { code } });
    return role?.get({ plain: true }) ?? null;
  },

  // Un rôle créé via l'API n'est jamais "système" : seuls ceux du script SQL le sont
  async create(data: RoleInput): Promise<RoleData> {
    return (await Role.create({ ...data, isSystem: false })).get({ plain: true });
  },

  async update(id: number, data: RoleUpdate): Promise<RoleData | null> {
    const role = await Role.findByPk(id);
    return role ? (await role.update(data)).get({ plain: true }) : null;
  },

  async delete(id: number): Promise<boolean> {
    return (await Role.destroy({ where: { id } })) > 0;
  },

  async countUsers(id: number): Promise<number> {
    const [row] = await sequelize.query<{ total: number }>(
      "SELECT COUNT(*) AS total FROM role_user WHERE role_id = :id",
      { replacements: { id }, type: QueryTypes.SELECT }
    );
    return Number(row?.total ?? 0);
  },

  // Codes des permissions de chaque rôle : { [roleId]: ["citizen.home.view", ...] }
  async permissionCodesByRole(): Promise<Record<number, string[]>> {
    const rows = await sequelize.query<{ role_id: number; code: string }>(
      `SELECT rp.role_id, p.code FROM role_permission rp
       JOIN permissions p ON p.id = rp.permission_id
       ORDER BY p.code`,
      { type: QueryTypes.SELECT }
    );
    const byRole: Record<number, string[]> = {};
    for (const row of rows) (byRole[Number(row.role_id)] ??= []).push(row.code);
    return byRole;
  },
};
