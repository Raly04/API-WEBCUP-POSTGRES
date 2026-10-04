import sequelize from "../src/config/database";

// Aide de tools/alert-check.mjs : roles <admin> <agentValide> | expire <alertId> | clean
(async () => {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === "roles") {
    await sequelize.query("INSERT INTO role_user (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.email=:a AND r.code='admin'", { replacements: { a } });
    await sequelize.query(
      "INSERT INTO role_user (user_id, role_id, assigned_by) SELECT u.id, r.id, (SELECT id FROM users WHERE email=:a) FROM users u, roles r WHERE u.email=:b AND r.code='agent'",
      { replacements: { a, b } }
    );
  } else if (mode === "requests") {
    // requests <email> <id1,id2,...> : une demande de cet habitant pour chaque service (test des services liés)
    for (const serviceId of b.split(",").map(Number)) {
      await sequelize.query(
        "INSERT INTO citizen_requests (user_id, service_id, subject, status) SELECT id, :serviceId, '[test] demande', 'pending' FROM users WHERE email = :a",
        { replacements: { a, serviceId } }
      );
    }
  } else if (mode === "expire") {
    await sequelize.query("UPDATE alerts SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = :id", { replacements: { id: Number(a) } });
  } else {
    const ids = "(SELECT id FROM users WHERE email LIKE 'alr_%@example.com')";
    await sequelize.query("DELETE FROM useful_contacts WHERE label LIKE '[test]%'");
    await sequelize.query(`DELETE FROM transport_disruptions WHERE created_by IN ${ids}`);
    await sequelize.query(`DELETE FROM alerts WHERE created_by IN ${ids}`);
    await sequelize.query(`DELETE FROM signalements WHERE user_id IN ${ids}`);
    await sequelize.query(`DELETE FROM audit_logs WHERE user_id IN ${ids}`);
    await sequelize.query("DELETE FROM users WHERE email LIKE 'alr_%@example.com'");
    console.log("nettoyé");
  }
  await sequelize.close();
})();
