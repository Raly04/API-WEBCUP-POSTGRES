import sequelize from "../src/config/database";

// Aide de tools/signalement-check.mjs : roles <admin> <agentValide> | backdate <id> <minutes> | clean
(async () => {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === "roles") {
    await sequelize.query("INSERT INTO role_user (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.email=:a AND r.code='admin'", { replacements: { a } });
    // agent VALIDÉ : rôle attribué par l'admin (assigned_by renseigné)
    await sequelize.query(
      "INSERT INTO role_user (user_id, role_id, assigned_by) SELECT u.id, r.id, (SELECT id FROM users WHERE email=:a) FROM users u, roles r WHERE u.email=:b AND r.code='agent'",
      { replacements: { a, b } }
    );
  } else if (mode === "backdate") {
    await sequelize.query("UPDATE signalements SET created_at = NOW() - (:m * INTERVAL '1 minute') WHERE id = :id", { replacements: { id: Number(a), m: Number(b) } });
  } else {
    const ids = "(SELECT id FROM users WHERE email LIKE 'sig_%@example.com')";
    await sequelize.query(`DELETE FROM signalements WHERE user_id IN ${ids}`);
    await sequelize.query(`DELETE FROM audit_logs WHERE user_id IN ${ids} OR entity_type = 'signalements'`);
    await sequelize.query("DELETE FROM users WHERE email LIKE 'sig_%@example.com'");
    console.log("nettoyé");
  }
  await sequelize.close();
})();
