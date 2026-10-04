// Crée les tables manquantes : npm run db:sync
// 1. Blocs 1-2 (users, auth, audit, RBAC) à partir des modèles Sequelize.
// 2. Bloc 3 (métier Terra Nova) à partir du SQL ci-dessous.
// Ne modifie jamais les tables existantes : rejouable sans erreur.
import { QueryTypes } from "sequelize";
import sequelize from "../config/database";
import "../models/user.model";
import "../models/authToken.model";
import "../models/auditLog.model";
import "../models/role.model";
import "../models/permission.model";
import "../models/rbac.model";
import "../models/municipalService.model";
import "../models/establishment.model";
import "../models/externalEntity.model";
import "../models/partnerService.model";
import "../models/partnerServiceRequest.model";
import "../models/project.model";
import "../models/knownDevice.model";
import { describeError } from "../utils/describeError";
import { logger } from "../utils/logger";

const MODELS =
  "users, auth_tokens, audit_logs, roles, permissions, role_user, role_permission, municipal_services, establishments, " +
  "external_entities, partner_services, partner_service_requests, projects, project_participants, " +
  "project_external_entities, project_comments, known_devices";

// PostgreSQL n'a pas l'« ON UPDATE CURRENT_TIMESTAMP » de MySQL : cette fonctiontrigger pose
// updated_at à chaque UPDATE, comme le faisait la colonne MySQL. Elle est créée une fois,
// puis rattachée à chaque table qui possède updated_at.
const TOUCH_UPDATED_AT = `
CREATE OR REPLACE FUNCTION fn_touch_updated_at() RETURNS TRIGGER AS $fn$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;`;

// Chaque étape est soit un CREATE TABLE (avec ses index et son trigger updated_at), soit
// l'ajout d'une colonne manquante. « IF NOT EXISTS » rend les deux rejouables sans sonde
// préalable : PostgreSQL le supporte nativement pour les tables comme pour les colonnes,
// ce qui n'était pas le cas sous MariaDB (d'où les 17 information_schema de l'ancienne version).
type Step =
  | { table: string; sql: string; touch?: boolean; indexes?: string[] }
  | { table: string; addColumn: { name: string; definition: string } };

const BLOC3: Step[] = [
  // 8. municipal_services
  {
    table: "municipal_services",
    sql: `
      CREATE TABLE IF NOT EXISTS municipal_services (
        id            BIGSERIAL PRIMARY KEY,
        code          VARCHAR(50)  NOT NULL UNIQUE,
        name          VARCHAR(150) NOT NULL,
        description   TEXT,
        icon          VARCHAR(255),
        is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
        sort_order    INT          NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMPTZ  NULL DEFAULT NULL
      )`,
    touch: true,
  },
  // 9. announcements
  {
    table: "announcements",
    sql: `
      CREATE TABLE IF NOT EXISTS announcements (
        id            BIGSERIAL PRIMARY KEY,
        title         VARCHAR(255) NOT NULL,
        content       TEXT         NOT NULL,
        status        TEXT         NOT NULL DEFAULT 'draft',
        priority      TEXT         NOT NULL DEFAULT 'default',
        author_id     BIGINT       NULL,
        published_at  TIMESTAMPTZ  NULL DEFAULT NULL,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMPTZ  NULL DEFAULT NULL,
        CONSTRAINT chk_announcements_status   CHECK (status IN ('draft', 'published', 'archived')),
        CONSTRAINT chk_announcements_priority CHECK (priority IN ('default', 'medium', 'max')),
        CONSTRAINT fk_announcements_author
          FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
      )`,
    touch: true,
    indexes: ["(status)", "(author_id)", "(published_at)"],
  },
  // 10. contact_messages
  {
    table: "contact_messages",
    sql: `
      CREATE TABLE IF NOT EXISTS contact_messages (
        id            BIGSERIAL PRIMARY KEY,
        user_id       BIGINT       NULL,
        subject       VARCHAR(255) NOT NULL,
        message       TEXT         NOT NULL,
        status        TEXT         NOT NULL DEFAULT 'new',
        sent_at       TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
        confirmed_at  TIMESTAMPTZ  NULL DEFAULT NULL,
        CONSTRAINT chk_contact_messages_status CHECK (status IN ('new', 'read', 'processed')),
        CONSTRAINT fk_contact_messages_user
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      )`,
    indexes: ["(user_id)", "(status)", "(sent_at)"],
  },
  // 11. citizen_requests
  {
    table: "citizen_requests",
    sql: `
      CREATE TABLE IF NOT EXISTS citizen_requests (
        id            BIGSERIAL PRIMARY KEY,
        user_id       BIGINT      NOT NULL,
        service_id    BIGINT      NULL,
        subject       VARCHAR(255) NOT NULL,
        description   TEXT,
        status        TEXT        NOT NULL DEFAULT 'pending',
        priority      TEXT        NOT NULL DEFAULT 'medium',
        assigned_to   BIGINT      NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMPTZ  NULL DEFAULT NULL,
        CONSTRAINT chk_citizen_requests_status   CHECK (status IN ('pending', 'in_progress', 'resolved', 'rejected')),
        CONSTRAINT chk_citizen_requests_priority CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
        CONSTRAINT fk_citizen_requests_user
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_citizen_requests_service
          FOREIGN KEY (service_id) REFERENCES municipal_services(id) ON DELETE SET NULL,
        CONSTRAINT fk_citizen_requests_assigned
          FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
      )`,
    touch: true,
    indexes: ["(user_id)", "(service_id)", "(assigned_to)", "(status)", "(priority)"],
  },
  // 12. request_status_history
  {
    table: "request_status_history",
    sql: `
      CREATE TABLE IF NOT EXISTS request_status_history (
        id          BIGSERIAL PRIMARY KEY,
        request_id  BIGINT      NOT NULL,
        old_status  VARCHAR(50) NULL,
        new_status  VARCHAR(50) NOT NULL,
        note        TEXT        NULL,
        changed_by  BIGINT      NULL,
        changed_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_request_status_history_request
          FOREIGN KEY (request_id) REFERENCES citizen_requests(id) ON DELETE CASCADE,
        CONSTRAINT fk_request_status_history_user
          FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
      )`,
    indexes: ["(request_id)", "(changed_by)", "(changed_at)"],
  },
  // 13b. appointments — prise de rendez-vous citoyen/agent
  // agent_id est RESTRICT (pas CASCADE) : un agent supprimé ne doit jamais entraîner la
  // disparition silencieuse des rendez-vous déjà réservés par des citoyens.
  {
    table: "appointments",
    sql: `
      CREATE TABLE IF NOT EXISTS appointments (
        id            BIGSERIAL PRIMARY KEY,
        agent_id      BIGINT      NOT NULL,
        service_id    BIGINT      NULL,
        citizen_id    BIGINT      NULL,
        start_at      TIMESTAMPTZ NOT NULL,
        end_at        TIMESTAMPTZ NOT NULL,
        location      VARCHAR(255),
        instructions  TEXT,
        subject       VARCHAR(500),
        status        TEXT        NOT NULL DEFAULT 'open',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMPTZ  NULL DEFAULT NULL,
        CONSTRAINT chk_appointments_status CHECK (status IN ('open', 'booked', 'cancelled')),
        CONSTRAINT fk_appointments_agent
          FOREIGN KEY (agent_id) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT fk_appointments_citizen
          FOREIGN KEY (citizen_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_appointments_service
          FOREIGN KEY (service_id) REFERENCES municipal_services(id) ON DELETE SET NULL
      )`,
    touch: true,
    indexes: ["(agent_id)", "(citizen_id)", "(status)", "(start_at)"],
  },
  // 13c. notifications — rappels (dont rendez-vous) ; appointment_id + type unique pour
  // qu'une génération paresseuse répétée (chaque lecture) ne duplique jamais un rappel.
  {
    table: "notifications",
    sql: `
      CREATE TABLE IF NOT EXISTS notifications (
        id             BIGSERIAL PRIMARY KEY,
        user_id        BIGINT      NOT NULL,
        type           TEXT        NOT NULL,
        title          VARCHAR(255) NOT NULL,
        body           TEXT        NOT NULL,
        appointment_id BIGINT      NULL,
        request_id     BIGINT      NULL,
        request_history_id BIGINT  NULL,
        announcement_id   BIGINT  NULL,
        read_at        TIMESTAMPTZ NULL DEFAULT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_notifications_type CHECK (type IN ('appointment_reminder', 'request_status', 'announcement', 'security_alert')),
        CONSTRAINT uq_notifications_appointment_type UNIQUE (appointment_id, type),
        CONSTRAINT uq_notifications_request_history UNIQUE (request_history_id),
        CONSTRAINT uq_notifications_announcement_type UNIQUE (announcement_id, type),
        CONSTRAINT fk_notifications_user
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_notifications_appointment
          FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
        CONSTRAINT fk_notifications_request
          FOREIGN KEY (request_id) REFERENCES citizen_requests(id) ON DELETE CASCADE,
        CONSTRAINT fk_notifications_request_history
          FOREIGN KEY (request_history_id) REFERENCES request_status_history(id) ON DELETE CASCADE,
        CONSTRAINT fk_notifications_announcement
          FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE
      )`,
    indexes: ["(user_id)", "(read_at)", "(request_id)"],
  },
  // 13d. service_reviews — avis (note 1 à 5 + commentaire) des citoyens sur un service ;
  // un seul avis par couple service/citoyen (clé unique)
  {
    table: "service_reviews",
    sql: `
      CREATE TABLE IF NOT EXISTS service_reviews (
        id          BIGSERIAL PRIMARY KEY,
        service_id  BIGINT      NOT NULL,
        user_id     BIGINT      NOT NULL,
        rating      SMALLINT   NOT NULL,
        comment     TEXT        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_service_reviews_rating CHECK (rating BETWEEN 1 AND 5),
        CONSTRAINT uq_service_reviews_service_user UNIQUE (service_id, user_id),
        CONSTRAINT fk_service_reviews_service
          FOREIGN KEY (service_id) REFERENCES municipal_services(id) ON DELETE CASCADE,
        CONSTRAINT fk_service_reviews_user
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
    indexes: ["(user_id)"],
  },
  // 13f. ideas — idées libres des habitants pour améliorer la ville ; pas de statut,
  // l'habitant n'en relit qu'à l'instant de l'envoi, la lecture revient à l'administration.
  {
    table: "ideas",
    sql: `
      CREATE TABLE IF NOT EXISTS ideas (
        id          BIGSERIAL PRIMARY KEY,
        user_id     BIGINT      NOT NULL,
        content     TEXT        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_ideas_user
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
    indexes: ["(user_id)"],
  },
  // 13g. idea_mentions — objets métier qu'une idée référence (demande, service, rendez-vous,
  // établissement, projet, annonce). Pas de FK vers les 6 tables : le pointeur est (type, id).
  {
    table: "idea_mentions",
    sql: `
      CREATE TABLE IF NOT EXISTS idea_mentions (
        id           BIGSERIAL PRIMARY KEY,
        idea_id      BIGINT      NOT NULL,
        target_type  TEXT        NOT NULL,
        target_id    BIGINT      NOT NULL,
        CONSTRAINT chk_idea_mentions_target_type
          CHECK (target_type IN ('request', 'service', 'appointment', 'establishment', 'project', 'announcement')),
        CONSTRAINT uq_idea_mentions_idea_target UNIQUE (idea_id, target_type, target_id),
        CONSTRAINT fk_idea_mentions_idea
          FOREIGN KEY (idea_id) REFERENCES ideas(id) ON DELETE CASCADE
      )`,
    indexes: ["(idea_id)"],
  },
  // 13k. guidance_requests — demandes d'orientation : l'habitant décrit un problème, la ville
  // répond par le service compétent et la démarche. Table distincte d'une citizen_request, qui
  // est le dossier déposé une fois l'orientation obtenue. `source` note si le modèle a répondu ou
  // si le routage par mots-clés a pris le relais, pour mesurer le taux de repli.
  {
    table: "guidance_requests",
    sql: `
      CREATE TABLE IF NOT EXISTS guidance_requests (
        id          BIGSERIAL PRIMARY KEY,
        user_id     BIGINT      NOT NULL,
        problem     TEXT        NOT NULL,
        service_id  BIGINT      NULL,
        summary     TEXT        NULL,
        steps       JSONB       NULL,
        source      TEXT        NOT NULL DEFAULT 'fallback',
        model       VARCHAR(60) NULL,
        request_id  BIGINT      NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_guidance_requests_source CHECK (source IN ('llm', 'fallback')),
        CONSTRAINT fk_guidance_requests_user
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_guidance_requests_service
          FOREIGN KEY (service_id) REFERENCES municipal_services(id) ON DELETE SET NULL,
        CONSTRAINT fk_guidance_requests_request
          FOREIGN KEY (request_id) REFERENCES citizen_requests(id) ON DELETE SET NULL
      )`,
    indexes: ["(user_id)", "(service_id)", "(created_at)"],
  },
  // 13. home_sections (D07)
  {
    table: "home_sections",
    sql: `
      CREATE TABLE IF NOT EXISTS home_sections (
        id          BIGSERIAL PRIMARY KEY,
        title       VARCHAR(150) NOT NULL,
        content     TEXT,
        position    INT         NOT NULL DEFAULT 0,
        is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMPTZ  NULL DEFAULT NULL
      )`,
    touch: true,
    indexes: ["(position)", "(is_active)"],
  },
  // 14. signalements — urgences et incidents (médical, incendie, inondation, panne...). user_id est SET NULL : une urgence
  // signalée reste tracée même si le compte du déclarant est supprimé ensuite.
  {
    table: "signalements",
    sql: `
      CREATE TABLE IF NOT EXISTS signalements (
        id               BIGSERIAL PRIMARY KEY,
        user_id          BIGINT      NULL,
        type             TEXT        NOT NULL,
        priority         TEXT        NOT NULL,
        status           TEXT        NOT NULL DEFAULT 'new',
        title            VARCHAR(200) NOT NULL,
        description      TEXT        NULL,
        location         VARCHAR(255) NOT NULL,
        contact_phone    VARCHAR(30) NULL,
        zone             VARCHAR(20) NULL,
        client_ref       VARCHAR(64) NULL,
        reported_at      TIMESTAMPTZ NULL DEFAULT NULL,
        assigned_to      BIGINT      NULL,
        acknowledged_at  TIMESTAMPTZ NULL DEFAULT NULL,
        resolved_at      TIMESTAMPTZ NULL DEFAULT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at       TIMESTAMPTZ  NULL DEFAULT NULL,
        CONSTRAINT chk_signalements_type CHECK (type IN ('medical', 'breakdown', 'fire', 'cyclone', 'heavy_rain', 'flood', 'accident', 'security', 'other')),
        CONSTRAINT chk_signalements_priority CHECK (priority IN ('urgent', 'high', 'medium', 'low')),
        CONSTRAINT chk_signalements_status CHECK (status IN ('new', 'acknowledged', 'in_progress', 'resolved', 'cancelled')),
        CONSTRAINT uq_signalements_client_ref UNIQUE (user_id, client_ref),
        CONSTRAINT fk_signalements_user
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_signalements_assigned
          FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
      )`,
    touch: true,
    indexes: ["(status, priority, created_at)", "(user_id)", "(assigned_to)", "(type)", "(zone, type, status)"],
  },
  // 14b. signalement_history — chaque prise en charge, changement de statut, de priorité ou d'assignation
  {
    table: "signalement_history",
    sql: `
      CREATE TABLE IF NOT EXISTS signalement_history (
        id             BIGSERIAL PRIMARY KEY,
        signalement_id BIGINT      NOT NULL,
        action         VARCHAR(30) NOT NULL,
        old_status     VARCHAR(20) NULL,
        new_status     VARCHAR(20) NULL,
        old_priority   VARCHAR(10) NULL,
        new_priority   VARCHAR(10) NULL,
        assigned_to    BIGINT      NULL,
        note           TEXT        NULL,
        changed_by     BIGINT      NULL,
        changed_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_signalement_history_signalement
          FOREIGN KEY (signalement_id) REFERENCES signalements(id) ON DELETE CASCADE,
        CONSTRAINT fk_signalement_history_user
          FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
      )`,
    indexes: ["(signalement_id)", "(changed_by)"],
  },
  // 15. alerts — alertes à la population par quartier (montée des eaux, incendie...), avec consignes et fin d'alerte.
  // zones : "south", "south,center" ou "all" (texte : la liste des quartiers peut évoluer sans migration).
  {
    table: "alerts",
    sql: `
      CREATE TABLE IF NOT EXISTS alerts (
        id           BIGSERIAL PRIMARY KEY,
        title        VARCHAR(160) NOT NULL,
        hazard       TEXT        NOT NULL,
        severity     TEXT        NOT NULL,
        zones        VARCHAR(100) NOT NULL,
        message      TEXT        NOT NULL,
        instructions TEXT        NULL,
        status       TEXT        NOT NULL DEFAULT 'active',
        starts_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at   TIMESTAMPTZ NOT NULL,
        ended_at     TIMESTAMPTZ NULL DEFAULT NULL,
        end_message  TEXT        NULL,
        version      INT         NOT NULL DEFAULT 1,
        created_by   BIGINT      NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMPTZ  NULL DEFAULT NULL,
        CONSTRAINT chk_alerts_hazard CHECK (hazard IN ('flood', 'heavy_rain', 'cyclone', 'fire', 'power_outage', 'water_outage', 'security', 'health', 'transport', 'network', 'other')),
        CONSTRAINT chk_alerts_severity CHECK (severity IN ('info', 'watch', 'warning', 'emergency')),
        CONSTRAINT chk_alerts_status CHECK (status IN ('active', 'ended')),
        CONSTRAINT fk_alerts_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )`,
    touch: true,
    indexes: ["(status, expires_at)"],
  },
  // 15b. alert_updates — l'évolution de la situation et la fin d'alerte
  {
    table: "alert_updates",
    sql: `
      CREATE TABLE IF NOT EXISTS alert_updates (
        id          BIGSERIAL PRIMARY KEY,
        alert_id    BIGINT      NOT NULL,
        message     TEXT        NOT NULL,
        severity    VARCHAR(20) NULL,
        created_by  BIGINT      NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_alert_updates_alert FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
        CONSTRAINT fk_alert_updates_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )`,
    indexes: ["(alert_id, created_at)"],
  },
  // 16b. transport_lines — lignes, arrêts (JSON ordonné) et grille horaire (JSON)
  {
    table: "transport_lines",
    sql: `
      CREATE TABLE IF NOT EXISTS transport_lines (
        id                    BIGSERIAL PRIMARY KEY,
        code                  VARCHAR(10)  NOT NULL,
        name                  VARCHAR(120) NOT NULL,
        mode                  TEXT         NOT NULL,
        color                 VARCHAR(7)   NOT NULL,
        stops                 TEXT         NOT NULL,
        zones                 VARCHAR(100) NOT NULL,
        frequency_minutes     SMALLINT     NULL,
        minutes_between_stops SMALLINT     NOT NULL DEFAULT 3,
        schedule              TEXT         NULL,
        wheelchair_accessible BOOLEAN      NOT NULL DEFAULT TRUE,
        notes                 VARCHAR(300) NULL,
        active                BOOLEAN      NOT NULL DEFAULT TRUE,
        sort_order            INT          NOT NULL DEFAULT 0,
        created_at            TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at            TIMESTAMPTZ   NULL DEFAULT NULL,
        CONSTRAINT chk_transport_lines_mode CHECK (mode IN ('bus', 'tram', 'shuttle', 'cable')),
        CONSTRAINT uq_transport_lines_code UNIQUE (code)
      )`,
    touch: true,
  },
  // 16c. transport_disruptions — interruption d'une ligne (toute la ligne ou une section) et solutions de remplacement
  {
    table: "transport_disruptions",
    sql: `
      CREATE TABLE IF NOT EXISTS transport_disruptions (
        id              BIGSERIAL PRIMARY KEY,
        line_id         BIGINT      NOT NULL,
        alert_id        BIGINT      NULL,
        kind            TEXT        NOT NULL,
        from_stop       VARCHAR(120) NULL,
        to_stop         VARCHAR(120) NULL,
        reason          VARCHAR(200) NOT NULL,
        alternatives    TEXT        NULL,
        status          TEXT        NOT NULL DEFAULT 'active',
        starts_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expected_end_at TIMESTAMPTZ NULL DEFAULT NULL,
        ended_at        TIMESTAMPTZ NULL DEFAULT NULL,
        created_by      BIGINT      NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMPTZ  NULL DEFAULT NULL,
        CONSTRAINT chk_transport_disruptions_kind CHECK (kind IN ('interrupted', 'delayed')),
        CONSTRAINT chk_transport_disruptions_status CHECK (status IN ('active', 'ended')),
        CONSTRAINT fk_transport_disruptions_line FOREIGN KEY (line_id) REFERENCES transport_lines(id) ON DELETE CASCADE,
        CONSTRAINT fk_transport_disruptions_alert FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE SET NULL,
        CONSTRAINT fk_transport_disruptions_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )`,
    touch: true,
    indexes: ["(status, line_id)", "(alert_id)"],
  },
  // 18. useful_contacts — coordonnées utiles (numéros de crise, centre médical, abris, points d'eau...)
  {
    table: "useful_contacts",
    sql: `
      CREATE TABLE IF NOT EXISTS useful_contacts (
        id             BIGSERIAL PRIMARY KEY,
        label          VARCHAR(150) NOT NULL,
        category       TEXT         NOT NULL,
        phone          VARCHAR(30)  NULL,
        email          VARCHAR(150) NULL,
        address        VARCHAR(255) NULL,
        zone           VARCHAR(20)  NULL,
        opening_hours  VARCHAR(150) NULL,
        available_24h  BOOLEAN      NOT NULL DEFAULT FALSE,
        description    VARCHAR(300) NULL,
        is_open        BOOLEAN      NOT NULL DEFAULT TRUE,
        status_note    VARCHAR(255) NULL,
        service_id     BIGINT       NULL,
        sort_order     INT          NOT NULL DEFAULT 0,
        is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMPTZ   NULL DEFAULT NULL,
        CONSTRAINT chk_useful_contacts_category
          CHECK (category IN ('emergency', 'crisis', 'health', 'shelter', 'water', 'utilities', 'transport', 'city', 'other')),
        CONSTRAINT fk_useful_contacts_service FOREIGN KEY (service_id) REFERENCES municipal_services(id) ON DELETE SET NULL
      )`,
    touch: true,
    indexes: ["(is_active, category, sort_order)"],
  },
  // 16. Double authentification (TOTP) des comptes citoyens (F53/F54) : la table users est gérée par
  // sequelize.sync() (bloc 1). IF NOT EXISTS rend ces colonnes rejouables sans information_schema.
  { table: "users", addColumn: { name: "two_factor_enabled", definition: "BOOLEAN NOT NULL DEFAULT FALSE" } },
  { table: "users", addColumn: { name: "two_factor_secret", definition: "VARCHAR(255) NULL" } },
  { table: "users", addColumn: { name: "two_factor_recovery_codes", definition: "TEXT NULL" } },
  { table: "users", addColumn: { name: "two_factor_last_counter", definition: "BIGINT NULL" } },
];

async function run() {
  try {
    await sequelize.sync();
    logger.info("DB", `Tables synchronisées : ${MODELS}`);

    // La fonction trigger est créée avant les tables : chaque CREATE TABLE peut la rattacher.
    await sequelize.query(TOUCH_UPDATED_AT);

    for (const step of BLOC3) {
      if ("sql" in step) {
        await sequelize.query(step.sql);
        if (step.touch) await attachTrigger(step.table);
        for (const cols of step.indexes ?? []) {
          const name = `idx_${step.table}${cols.replace(/[^a-z0-9]+/gi, "_")}`;
          await sequelize.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${step.table} ${cols}`);
        }
        continue;
      }
      if ("addColumn" in step) {
        await sequelize.query(
          `ALTER TABLE ${step.table} ADD COLUMN IF NOT EXISTS ${step.addColumn.name} ${step.addColumn.definition}`
        );
        logger.info("DB", `Colonne vérifiée : ${step.table}.${step.addColumn.name}`);
      }
    }
    await setTimestampDefaults();
    logger.info("DB", `Tables du bloc 3 en place : ${[...new Set(BLOC3.map((t) => t.table))].join(", ")}`);
  } catch (err) {
    const { summary, hint, detail } = describeError(err);
    logger.error("DB", `${summary}${hint ? `\n  Piste : ${hint}` : ""}\n  Détail : ${detail}`);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

// Pose DEFAULT CURRENT_TIMESTAMP sur les colonnes created_at / updated_at qui n'en ont pas.
//
// MySQL remplirait implicitement une colonne TIMESTAMP NOT NULL ; PostgreSQL refuse
// l'INSERT ("null value in column … violates not-null constraint"). Le `defaultValue` d'un
// modèle Sequelize ne produit pas de DEFAULT dans le DDL — il ne sert qu'aux INSERT passés
// par l'ORM — il faut donc le poser ici, en SQL, pour les requêtes directes (scripts de
// test, outils d'administration, seed).
async function setTimestampDefaults() {
  // Colonnes d'horodatage de CRÉATION : l'instant est imposé par la base. La liste est
  // explicite et non un simple « toutes les colonnes NOT NULL sans DEFAULT » : expires_at,
  // start_at et end_at sont elles aussi NOT NULL, mais leur valeur est une donnée métier
  // que le code fournit (durée d'un jeton, créneau d'un rendez-vous) — leur donner l'heure
  // courante par défaut masquerait l'oubli au lieu de le signaler.
  const CREATED_AT_COLUMNS = [
    "created_at", "updated_at",
    "assigned_at",  // role_user : quand le rôle a été attribué
    "granted_at",   // role_permission : quand la permission a été accordée
    "added_at",     // project_participants / project_external_entities
    "first_seen_at", // known_devices : première connexion de l'appareil
    "last_seen_at",  // known_devices : dernière connexion
  ];
  const rows = await sequelize.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND column_name IN (:columns)
       AND column_default IS NULL
       AND data_type = 'timestamp with time zone'`,
    { replacements: { columns: CREATED_AT_COLUMNS }, type: QueryTypes.SELECT }
  );
  for (const row of rows) {
    await sequelize.query(
      `ALTER TABLE ${row.table_name} ALTER COLUMN ${row.column_name} SET DEFAULT CURRENT_TIMESTAMP`
    );
  }
  if (rows.length > 0) {
    logger.info("DB", `DEFAULT CURRENT_TIMESTAMP posé sur ${rows.length} colonne(s) de timestamp`);
  }
}

// Rattache fn_touch_updated_at à une table. IF NOT EXISTS n'existe pas pour un trigger en PG :
// on teste donc pg_trigger avant de créer, ce qui garde le script rejouable.
// QueryTypes.SELECT est indispensable : sans lui sequelize.query renvoie [résultat, metadata]
// et existing.length vaut 2 même sans aucune ligne. Le trigger serait alors toujours considéré
// comme déjà présent, et jamais créé.
async function attachTrigger(table: string) {
  const name = `trg_${table}_updated_at`;
  const existing = await sequelize.query(
    `SELECT 1 FROM pg_trigger WHERE tgname = :name AND NOT tgisinternal`,
    { replacements: { name }, type: QueryTypes.SELECT }
  );
  if (existing.length > 0) return;
  await sequelize.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at()`);
}

void run();
