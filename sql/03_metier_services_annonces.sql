-- ============================================================
-- TERRA NOVA — 24H by Webcup
-- Bloc 3 : Métier (services municipaux, annonces)
-- Idempotent : peut être rejoué sans effet de bord.
-- ============================================================

SET NAMES utf8mb4;

-- ------------------------------------------------------------
-- 8. municipal_services
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `municipal_services` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code`         VARCHAR(50)     NOT NULL,
  `name`         VARCHAR(150)    NOT NULL,
  `description`  TEXT            DEFAULT NULL,
  `icon`         VARCHAR(255)    DEFAULT NULL,
  `is_active`    TINYINT(1)      NOT NULL DEFAULT 1,
  `sort_order`   INT             NOT NULL DEFAULT 0,
  `created_at`   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_municipal_services_code` (`code`),
  KEY `idx_municipal_services_active_sort` (`is_active`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ------------------------------------------------------------
-- 9. announcements
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `announcements` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title`         VARCHAR(255)    NOT NULL,
  `content`       TEXT            NOT NULL,
  `status`        ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  `author_id`     BIGINT UNSIGNED DEFAULT NULL,
  `published_at`  TIMESTAMP       NULL DEFAULT NULL,
  `created_at`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
                                  ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_announcements_status_published` (`status`, `published_at`),
  KEY `idx_announcements_author` (`author_id`),
  CONSTRAINT `fk_announcements_author`
    FOREIGN KEY (`author_id`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ------------------------------------------------------------
-- Permissions de gestion du bloc 3
-- (la lecture reste couverte par citizen.services.view et citizen.announcements.view)
-- ------------------------------------------------------------
INSERT IGNORE INTO `permissions` (`code`, `label`, `module`) VALUES
  ('admin.services.manage',      'Gérer les services municipaux', 'admin'),
  ('agent.announcements.manage', 'Gérer les annonces',            'agent');

-- Services : administrateur uniquement
INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT r.id, p.id FROM `roles` r JOIN `permissions` p ON p.code = 'admin.services.manage'
WHERE r.code = 'admin';

-- Annonces : agent et administrateur
INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT r.id, p.id FROM `roles` r JOIN `permissions` p ON p.code = 'agent.announcements.manage'
WHERE r.code IN ('agent', 'admin');
