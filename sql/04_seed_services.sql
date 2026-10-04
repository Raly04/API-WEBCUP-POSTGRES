-- ============================================================
-- TERRA NOVA — 24H by Webcup
-- Seed : services municipaux
-- Idempotent : INSERT IGNORE sur le code unique, donc rejouable sans
-- écraser les modifications faites ensuite par un administrateur.
-- Les icônes sont des noms d'icônes (ex. Lucide) que le front interprète.
-- ============================================================

SET NAMES utf8mb4;

INSERT IGNORE INTO `municipal_services` (`code`, `name`, `description`, `icon`, `is_active`, `sort_order`) VALUES
  ('etat_civil',
   'État civil et identité',
   'Inscription des nouveaux habitants, actes de naissance, mariage et décès, cartes d''identité de Terra Nova et changements d''adresse.',
   'id-card', 1, 10),

  ('eau_energie',
   'Eau et énergie',
   'Distribution d''eau recyclée, production d''énergie solaire et géothermique, suivi de consommation et signalement des pannes.',
   'zap', 1, 20),

  ('transport',
   'Transports et mobilité',
   'Navettes entre les dômes, horaires, abonnements, stationnement des véhicules et déplacements vers les zones extérieures.',
   'bus', 1, 30),

  ('sante',
   'Santé et secours',
   'Centres médicaux, rendez-vous, urgences, vaccination, suivi de l''adaptation à la gravité et à l''atmosphère de la planète.',
   'heart-pulse', 1, 40),

  ('securite',
   'Sécurité et protection civile',
   'Alertes de sécurité, évacuations, protection contre les tempêtes de poussière et les radiations, assistance d''urgence.',
   'shield-check', 1, 50),

  ('logement',
   'Logement et habitat',
   'Attribution et entretien des logements, demandes de travaux, extension des habitations et gestion des parties communes.',
   'home', 1, 60),

  ('environnement',
   'Environnement et agriculture',
   'Serres et cultures, gestion des déchets et du recyclage, qualité de l''air, préservation des écosystèmes de Terra Nova.',
   'sprout', 1, 70),

  ('education',
   'Éducation et formation',
   'Écoles, formations professionnelles, bibliothèque numérique et programmes pour les nouveaux arrivants.',
   'graduation-cap', 1, 80),

  ('commerce_emploi',
   'Commerce et emploi',
   'Offres d''emploi, création d''activité, marchés locaux, approvisionnement et aides aux entrepreneurs.',
   'briefcase', 1, 90),

  ('culture_loisirs',
   'Culture et loisirs',
   'Événements, équipements sportifs, lieux de rencontre et activités pour tous les habitants.',
   'palette', 1, 100),

  ('communications',
   'Communications et réseau',
   'Réseau interne, liaison avec la Terre, accès aux services numériques et assistance technique.',
   'radio', 1, 110),

  ('haut_conseil',
   'Haut Conseil de Terra Nova',
   'Contacter le Haut Conseil, suivre les décisions, participer aux consultations et déposer une proposition citoyenne.',
   'landmark', 1, 120);
