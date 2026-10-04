import crypto from "crypto";
import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model } from "sequelize";
import sequelize from "../config/database";

// Un appareil déjà vu par un compte : sert uniquement à détecter une PREMIÈRE connexion depuis un
// appareil inconnu (F54), jamais purgé à la déconnexion ou à l'expiration d'une session (contrairement
// à auth_tokens) — sinon un appareil habituel redeviendrait "nouveau" dès que ses sessions expirent,
// et le citoyen recevrait une alerte à chaque reconnexion.
export class KnownDevice extends Model<InferAttributes<KnownDevice>, InferCreationAttributes<KnownDevice>> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare fingerprint: string;
  declare label: CreationOptional<string | null>;
  declare firstSeenAt: CreationOptional<Date>;
  declare lastSeenAt: CreationOptional<Date>;
}

KnownDevice.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    fingerprint: { type: DataTypes.CHAR(64), allowNull: false },
    label: { type: DataTypes.STRING(255), allowNull: true },
    firstSeenAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    lastSeenAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "known_devices", updatedAt: false, createdAt: false }
);

// Repris tel quel (user-agent brut) : plus discriminant que le libellé affiché ("Chrome sur Windows",
// voir utils/mask.ts describeDevice) qui regrouperait des appareils distincts partageant le même
// navigateur et le même système.
function fingerprintOf(userAgent: string | null | undefined): string {
  return crypto.createHash("sha256").update(userAgent || "unknown").digest("hex");
}

export const KnownDeviceModel = {
  // true si l'appareil vient d'être enregistré pour la première fois (donc "nouveau" pour ce compte)
  async registerLogin(userId: number, userAgent: string | null | undefined, label: string): Promise<{ isNew: boolean }> {
    const fingerprint = fingerprintOf(userAgent);
    const [device, created] = await KnownDevice.findOrCreate({
      where: { userId, fingerprint },
      defaults: { userId, fingerprint, label },
    });
    if (!created) await device.update({ lastSeenAt: new Date() });
    return { isNew: created };
  },
};
