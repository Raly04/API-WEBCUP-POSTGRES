import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model, QueryTypes } from "sequelize";
import sequelize from "../config/database";

// ── Table permissions ────────────────────────────────────────
export class Permission extends Model<InferAttributes<Permission>, InferCreationAttributes<Permission>> {
  declare id: CreationOptional<number>;
  declare code: string;
  declare label: string;
  declare module: string;
  declare createdAt: CreationOptional<Date>;
}

Permission.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    code: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    label: { type: DataTypes.STRING(150), allowNull: false },
    module: { type: DataTypes.STRING(50), allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "permissions", updatedAt: false }
);

export type PermissionData = InferAttributes<Permission>;

// ── Accès aux données ────────────────────────────────────────
export const PermissionModel = {
  async list(module?: string): Promise<PermissionData[]> {
    const permissions = await Permission.findAll({
      where: module ? { module } : {},
      order: [["module", "ASC"], ["code", "ASC"]],
    });
    return permissions.map((permission) => permission.get({ plain: true }));
  },

  async findById(id: number): Promise<PermissionData | null> {
    const permission = await Permission.findByPk(id);
    return permission?.get({ plain: true }) ?? null;
  },

  async findByCode(code: string): Promise<PermissionData | null> {
    const permission = await Permission.findOne({ where: { code } });
    return permission?.get({ plain: true }) ?? null;
  },

  async findByCodes(codes: string[]): Promise<PermissionData[]> {
    if (codes.length === 0) return [];
    const permissions = await Permission.findAll({ where: { code: codes } });
    return permissions.map((permission) => permission.get({ plain: true }));
  },

  async create(data: { code: string; label: string; module: string }): Promise<PermissionData> {
    return (await Permission.create(data)).get({ plain: true });
  },

  // Le code est immuable : il est référencé dans le code (requirePermission)
  async update(id: number, data: { label?: string; module?: string }): Promise<PermissionData | null> {
    const permission = await Permission.findByPk(id);
    return permission ? (await permission.update(data)).get({ plain: true }) : null;
  },

  async delete(id: number): Promise<boolean> {
    return (await Permission.destroy({ where: { id } })) > 0;
  },

  // Codes des rôles qui possèdent cette permission
  async roleCodesUsing(id: number): Promise<string[]> {
    const rows = await sequelize.query<{ code: string }>(
      `SELECT r.code FROM roles r
       JOIN role_permission rp ON rp.role_id = r.id
       WHERE rp.permission_id = :id
       ORDER BY r.level`,
      { replacements: { id }, type: QueryTypes.SELECT }
    );
    return rows.map((row) => row.code);
  },

  // Permissions d'un rôle
  async listForRole(roleId: number): Promise<PermissionData[]> {
    const permissions = await Permission.findAll({
      where: {
        id: sequelize.literal(`id IN (SELECT permission_id FROM role_permission WHERE role_id = ${Number(roleId)})`),
      },
      order: [["module", "ASC"], ["code", "ASC"]],
    });
    return permissions.map((permission) => permission.get({ plain: true }));
  },

  // Permissions effectives d'un utilisateur : union de celles de tous ses rôles
  async codesForUser(userId: number): Promise<string[]> {
    const rows = await sequelize.query<{ code: string }>(
      `SELECT DISTINCT p.code FROM permissions p
       JOIN role_permission rp ON rp.permission_id = p.id
       JOIN role_user ru ON ru.role_id = rp.role_id
       WHERE ru.user_id = :userId
       ORDER BY p.code`,
      { replacements: { userId }, type: QueryTypes.SELECT }
    );
    return rows.map((row) => row.code);
  },

  async countAll(): Promise<number> {
    return Permission.count();
  },
};
