import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model, Op } from "sequelize";
import sequelize from "../config/database";
import { logger } from "../utils/logger";
import { Announcement } from "./announcement.model";
import { Appointment } from "./appointment.model";
import { RequestStatusHistory, type RequestStatus } from "./citizenRequest.model";

export const NOTIFICATION_TYPES = ["appointment_reminder", "request_status", "announcement", "security_alert"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// Fenêtre avant le rendez-vous pendant laquelle un rappel est généré. Une seule valeur,
// pas de configuration par citoyen : suffisant pour le besoin exprimé ("être rappelé
// avant mon rendez-vous"), pas une plateforme de préférences de notification.
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

// Nombre maximal d'historiques de statuts relus à chaque lecture. Au-delà, le citoyen consulte
// l'historique de sa demande : la notification est un rappel, pas un rapport.
const STATUS_NOTIFICATION_WINDOW = 200;

// Une annonce published il y a plus d'une semaine n'est plus une actualité : l'habitant qui
// revient après une absence la lit dans la liste des annonces, pas dans sa cloche. Cette borne
// évite aussi de rejouer la requête sur tout l'historique à chaque lecture du compteur.
const ANNOUNCEMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Nombre maximum d'annonces reprises par lecture, sécurité si plusieurs annonces prioritaires
// tombent le même jour.
const ANNOUNCEMENT_NOTIFICATION_WINDOW = 24;

// ── Table notifications ───────────────────────────────────────
export class Notification extends Model<InferAttributes<Notification>, InferCreationAttributes<Notification>> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare type: NotificationType;
  declare title: string;
  declare body: string;
  declare appointmentId: CreationOptional<number | null>;
  declare requestId: CreationOptional<number | null>;
  declare requestHistoryId: CreationOptional<number | null>;
  // Annonce décrite par la notification : permet au client d'ouvrir l'annonce elle-même.
  // Null pour les deux autres types.
  declare announcementId: CreationOptional<number | null>;
  declare readAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
}

Notification.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    type: { type: DataTypes.ENUM(...NOTIFICATION_TYPES), allowNull: false },
    title: { type: DataTypes.STRING(255), allowNull: false },
    body: { type: DataTypes.TEXT, allowNull: false },
    appointmentId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    requestId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    requestHistoryId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    announcementId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    readAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "notifications", underscored: true, updatedAt: false }
);

export type NotificationData = InferAttributes<Notification>;

// Le texte est figé en base à la génération, donc il doit être écrit dans la langue du
// citoyen au moment où le rappel est créé : le réécrire plus tard est impossible. La locale
// vient du header Accept-Language, la seule information disponible ici (le JWT ne porte
// pas de locale et le profil utilisateur n'en stocke pas).
export type NotificationLocale = "fr" | "en";

const LOCALE_TAGS: Record<NotificationLocale, string> = { fr: "fr-FR", en: "en-GB" };
const dateFormatters: Record<NotificationLocale, Intl.DateTimeFormat> = {
  fr: new Intl.DateTimeFormat("fr-FR", { dateStyle: "full" }),
  en: new Intl.DateTimeFormat("en-GB", { dateStyle: "full" }),
};
const timeFormatters: Record<NotificationLocale, Intl.DateTimeFormat> = {
  fr: new Intl.DateTimeFormat("fr-FR", { timeStyle: "short" }),
  en: new Intl.DateTimeFormat("en-GB", { timeStyle: "short" }),
};

// "q" donne le poids de chaque langue ("en;q=0.8,fr;q=0.9") : on prend celle qui pèse le plus.
export function resolveLocale(acceptLanguage: string | undefined): NotificationLocale {
  if (!acceptLanguage) return "fr";
  const ranked = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((entry) => entry.tag && Number.isFinite(entry.q))
    .sort((a, b) => b.q - a.q);

  const winner = ranked.find((entry) => entry.tag.startsWith("fr") || entry.tag.startsWith("en"));
  return winner?.tag.startsWith("en") ? "en" : "fr";
}

function reminderText(appointment: Appointment, locale: NotificationLocale) {
  const dateFormatter = dateFormatters[locale];
  const timeFormatter = timeFormatters[locale];
  const agentName = [appointment.agent?.firstName, appointment.agent?.lastName].filter(Boolean).join(" ");
  const when = `${dateFormatter.format(appointment.startAt)}${locale === "fr" ? " à " : " at "}${timeFormatter.format(appointment.startAt)}`;

  if (locale === "en") {
    const title = "Reminder: upcoming appointment";
    const parts = [`You have an appointment on ${when}`];
    if (agentName) parts.push(`with ${agentName}`);
    if (appointment.service?.name) parts.push(`(${appointment.service.name})`);
    let body = `${parts.join(" ")}.`;
    body += ` Location: ${appointment.location || "not specified"}.`;
    if (appointment.instructions) body += ` To bring: ${appointment.instructions}`;
    return { title, body };
  }

  const title = "Rappel : rendez-vous à venir";
  const parts = [`Vous avez un rendez-vous le ${when}`];
  if (agentName) parts.push(`avec ${agentName}`);
  if (appointment.service?.name) parts.push(`(${appointment.service.name})`);
  let body = `${parts.join(" ")}.`;
  body += ` Lieu : ${appointment.location || "non précisé"}.`;
  if (appointment.instructions) body += ` À prévoir : ${appointment.instructions}`;
  return { title, body };
}

// Ce que le citoyen doit comprendre, et ce qu'il a à faire, dépend de l'état atteint :
// une demande rejetée appelle une réponse de sa part, les autres l'appellent à patienter.
function requestStatusText(
  input: { subject: string; status: RequestStatus; note: string | null },
  locale: NotificationLocale,
) {
  const reason = input.note?.trim();
  if (locale === "en") {
    switch (input.status) {
      case "in_progress":
        return {
          title: "Your request is being processed",
          body: `The request "${input.subject}" is now being handled by an agent. No action is required from you.`,
        };
      case "resolved":
        return {
          title: "Your request has been processed",
          body: `The request "${input.subject}" has been processed.${reason ? ` Agent note: ${reason}` : ""}`,
        };
      case "rejected":
        return {
          title: "Your request was declined",
          body: `The request "${input.subject}" was declined.${reason ? ` Reason: ${reason}` : ""} Submit a new request if you disagree.`,
        };
      default:
        return {
          title: "Your request is registered again",
          body: `The request "${input.subject}" is back in the queue. No action is required from you.`,
        };
    }
  }

  switch (input.status) {
    case "in_progress":
      return {
        title: "Votre demande est en cours de traitement",
        body: `La demande « ${input.subject} » est prise en charge par un agent. Aucune action n’est attendue de votre part.`,
      };
    case "resolved":
      return {
        title: "Votre demande a été traitée",
        body: `La demande « ${input.subject} » a été traitée.${reason ? ` Motif de l’agent : ${reason}` : ""}`,
      };
    case "rejected":
      return {
        title: "Votre demande a été refusée",
        body: `La demande « ${input.subject} » a été refusée.${reason ? ` Motif : ${reason}` : ""} Vous pouvez déposer une nouvelle demande.`,
      };
    default:
      return {
        title: "Votre demande est de nouveau enregistrée",
        body: `La demande « ${input.subject} » repasse en file d’attente. Aucune action n’est attendue de votre part.`,
      };
  }
}

// Un corps d'annonce est long : la notification n'en garde qu'un extrait, sinon la cloche
// pousse le reste des notifications hors de l'écran.
const ANNOUNCEMENT_BODY_LENGTH = 160;

// L'annonce doit dire quoi faire, pas seulement qu'elle existe : le titre rappelle la priorité,
// le corps commence par le message lui-même. Une annonce "max" est un ordre du Haut Conseil.
function announcementText(
  announcement: { title: string; content: string; priority: "default" | "medium" | "max" },
  locale: NotificationLocale,
) {
  const summary =
    announcement.content.length > ANNOUNCEMENT_BODY_LENGTH
      ? `${announcement.content.slice(0, ANNOUNCEMENT_BODY_LENGTH).trimEnd()}…`
      : announcement.content;

  if (announcement.priority === "max") {
    return locale === "en"
      ? {
          title: "High Council: immediate notice",
          body: `${announcement.title} — ${summary}`,
        }
      : {
          title: "Haut Conseil : information immédiate",
          body: `${announcement.title} — ${summary}`,
        };
  }

  return locale === "en"
    ? { title: "Priority announcement", body: `${announcement.title} — ${summary}` }
    : { title: "Annonce prioritaire", body: `${announcement.title} — ${summary}` };
}

// Contrairement aux trois autres types, générés paresseusement à la lecture (le texte peut attendre),
// une connexion depuis un nouvel appareil doit apparaître tout de suite : c'est le signal qui permet
// à un citoyen de réagir (déconnecter l'appareil, changer son mot de passe) pendant qu'il est encore
// utile. Écrite à la connexion (voir controllers/accountSecurity.controller.recordDeviceLogin).
function newDeviceLoginText(input: { device: string; ip: string | null; at: Date }, locale: NotificationLocale) {
  const dateFormatter = dateFormatters[locale];
  const timeFormatter = timeFormatters[locale];
  const when = `${dateFormatter.format(input.at)}${locale === "fr" ? " à " : " at "}${timeFormatter.format(input.at)}`;
  const where = input.ip ? ` (${input.ip})` : "";

  if (locale === "en") {
    return {
      title: "New sign-in detected",
      body: `Your account was just accessed from a device we haven't seen before: ${input.device}${where}, on ${when}. If this wasn't you, change your password and close the session from your account security page.`,
    };
  }
  return {
    title: "Nouvelle connexion détectée",
    body: `Votre compte vient d’être utilisé depuis un appareil que nous ne connaissions pas : ${input.device}${where}, le ${when}. Si ce n’était pas vous, changez votre mot de passe et fermez cette session depuis la sécurité de votre compte.`,
  };
}

export const NotificationModel = {
  async notifyNewDeviceLogin(
    userId: number,
    input: { device: string; ip: string | null; at: Date },
    locale: NotificationLocale = "fr"
  ): Promise<void> {
    const { title, body } = newDeviceLoginText(input, locale);
    await Notification.create({ userId, type: "security_alert", title, body });
  },

  // Une entrée de request_status_history = un changement d'état = une notification à produire.
  // Dédoublonnage par history_id (unique) et non par (request_id, status) : un refus peut être
  // suivi d'une réexamen puis d'un nouveau refus, et ces deux refus doivent produire deux lignes.
  // Génération paresseuse, comme les rappels : le texte est figé en base, donc il est écrit dans
  // la langue du citoyen qui le lit, jamais dans celle de l'agent qui a fait la transition.
  async ensureRequestStatusNotifications(userId: number, locale: NotificationLocale = "fr"): Promise<void> {
    const histories = await RequestStatusHistory.findAll({
      include: [{ association: "request", attributes: ["id", "subject"] }],
      where: { "$request.user_id$": userId },
      order: [["changedAt", "DESC"]],
      limit: STATUS_NOTIFICATION_WINDOW,
    });
    if (histories.length === 0) return;

    const ids = histories.map((h) => h.id);
    const existing = await Notification.findAll({
      where: { requestHistoryId: { [Op.in]: ids } },
      attributes: ["requestHistoryId"],
    });
    const already = new Set(existing.map((n) => n.requestHistoryId));

    const toCreate = histories
      // oldStatus null = entrée de création : le citoyen vient de déposer la demande, il n'a pas
      // subi de changement d'état et n'a rien à comprendre de plus. Seules les vraies transitions
      // (rejet puis réexamen inclus) notifient.
      .filter((h) => h.oldStatus !== null && !already.has(h.id))
      .map((h) => {
        const { title, body } = requestStatusText(
          { subject: h.request?.subject ?? "", status: h.newStatus, note: h.note },
          locale,
        );
        return {
          userId,
          type: "request_status" as const,
          title,
          body,
          requestId: h.requestId,
          requestHistoryId: h.id,
        };
      });
    // ignoreDuplicates : deux lectures concurrentes (liste + compteur pollé) peuvent passer toutes
    // deux le contrôle ci-dessus ; c'est la contrainte unique en base qui tranche.
    if (toCreate.length > 0) await Notification.bulkCreate(toCreate, { ignoreDuplicates: true });
  },

  async listForUser(userId: number, filters: { onlyUnread?: boolean; limit: number; offset: number }) {
    const where: Record<string | symbol, unknown> = { userId };
    if (filters.onlyUnread) where.readAt = null;
    const { rows, count } = await Notification.findAndCountAll({
      where,
      order: [["createdAt", "DESC"]],
      limit: filters.limit,
      offset: filters.offset,
    });
    return { notifications: rows.map((row) => row.get({ plain: true }) as NotificationData), total: count };
  },

  async countUnread(userId: number): Promise<number> {
    return Notification.count({ where: { userId, readAt: null } });
  },

  // L'appartenance est un critère de recherche : un identifiant deviné par un autre
  // utilisateur ne permet jamais de marquer lu une notification qui n'est pas la sienne.
  async markRead(id: number, userId: number): Promise<boolean> {
    const [affected] = await Notification.update(
      { readAt: new Date() },
      { where: { id, userId, readAt: null } }
    );
    return affected > 0;
  },

  async markAllRead(userId: number): Promise<number> {
    const [affected] = await Notification.update(
      { readAt: new Date() },
      { where: { userId, readAt: null } }
    );
    return affected;
  },

  // Un rendez-vous annulé ne doit jamais laisser un rappel en suspens pour un événement
  // qui n'aura plus lieu : la notification part avec le rendez-vous qu'elle décrivait.
  // Best-effort, comme audit() : l'annulation elle-même a déjà été committée sans
  // transaction englobante, donc un échec ici ne doit jamais faire échouer la requête
  // et laisser croire au citoyen que son annulation n'a pas eu lieu.
  async deleteForAppointment(appointmentId: number): Promise<void> {
    try {
      await Notification.destroy({ where: { appointmentId, type: "appointment_reminder" } });
    } catch (err) {
      logger.error(
        "NOTIFICATION",
        `Échec du nettoyage des rappels du rendez-vous ${appointmentId}`,
        err instanceof Error ? err.message : err
      );
    }
  },

  // Génération paresseuse : appelée à chaque lecture des notifications/compteur d'un
  // citoyen plutôt que par une tâche planifiée (aucun ordonnanceur dans ce projet). Le
  // rappel apparaît donc dès que le citoyen est actif dans l'application pendant la
  // fenêtre, sans dépendre d'un envoi externe (email/SMS) non configuré ici.
  async ensureAppointmentReminders(userId: number, locale: NotificationLocale = "fr"): Promise<void> {
    const now = new Date();
    const horizon = new Date(now.getTime() + REMINDER_WINDOW_MS);

    const due = await Appointment.findAll({
      where: { citizenId: userId, status: "booked", startAt: { [Op.gt]: now, [Op.lte]: horizon } },
      include: [
        { association: "agent", attributes: ["id", "firstName", "lastName"] },
        { association: "service", attributes: ["id", "code", "name"] },
      ],
    });
    if (due.length === 0) return;

    const existing = await Notification.findAll({
      where: { appointmentId: { [Op.in]: due.map((a) => a.id) }, type: "appointment_reminder" },
      attributes: ["appointmentId"],
    });
    const already = new Set(existing.map((n) => n.appointmentId));

    const toCreate = due
      .filter((appointment) => !already.has(appointment.id))
      .map((appointment) => {
        const { title, body } = reminderText(appointment, locale);
        return { userId, type: "appointment_reminder" as const, title, body, appointmentId: appointment.id };
      });
    // ignoreDuplicates (INSERT IGNORE) : filet de sécurité si deux requêtes concurrentes
    // (liste + compteur pollé en même temps) passent toutes deux le check ci-dessus avant
    // l'écriture ; l'unicité (appointment_id, type) en base tranche, pas une course perdue.
    if (toCreate.length > 0) await Notification.bulkCreate(toCreate, { ignoreDuplicates: true });
  },

  // Annonce publiée et prioritaire (medium ou max) = une information que l'habitant doit avoir
  // même s'il n'était pas devant son écran au moment de la publication. Génération paresseuse,
  // comme les deux autres : le texte est figé en base dans la langue du lecteur.
  // L'auteur de l'annonce n'est pas notifié : il vient de la publier, il la connaît.
  async ensureAnnouncementNotifications(userId: number, locale: NotificationLocale = "fr"): Promise<void> {
    const publishedAfter = new Date(Date.now() - ANNOUNCEMENT_MAX_AGE_MS);

    const announcements = await Announcement.findAll({
      where: {
        status: "published",
        priority: { [Op.in]: ["medium", "max"] },
        authorId: { [Op.ne]: userId },
        publishedAt: { [Op.gte]: publishedAfter },
      },
      attributes: ["id", "title", "content", "priority"],
      order: [["publishedAt", "DESC"]],
      limit: ANNOUNCEMENT_NOTIFICATION_WINDOW,
    });
    if (announcements.length === 0) return;

    const ids = announcements.map((a) => a.id);
    const existing = await Notification.findAll({
      where: { announcementId: { [Op.in]: ids }, userId },
      attributes: ["announcementId"],
    });
    const already = new Set(existing.map((n) => n.announcementId));

    const toCreate = announcements
      .filter((announcement) => !already.has(announcement.id))
      .map((announcement) => {
        const { title, body } = announcementText(announcement, locale);
        return { userId, type: "announcement" as const, title, body, announcementId: announcement.id };
      });
    if (toCreate.length > 0) await Notification.bulkCreate(toCreate, { ignoreDuplicates: true });
  },
};
