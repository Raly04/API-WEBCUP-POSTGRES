import fs from "fs";
import path from "path";
import sequelize from "../src/config/database";

// Aide de tools/security-check.mjs : roles <email agent> <email admin> | clean
(async () => {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === "roles") {
    for (const [email, role] of [[a, "agent"], [b, "admin"]]) {
      await sequelize.query(
        "INSERT INTO role_user (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.email=:email AND r.code=:role",
        { replacements: { email, role } }
      );
    }
  } else {
    const ids = "(SELECT id FROM users WHERE email LIKE 'sec_%@example.com')";
    await sequelize.query(`DELETE FROM notifications WHERE user_id IN ${ids}`);
    await sequelize.query(`DELETE FROM appointments WHERE agent_id IN ${ids}`);
    await sequelize.query(`DELETE FROM citizen_requests WHERE user_id IN ${ids}`);
    await sequelize.query(`DELETE FROM contact_messages WHERE user_id IN ${ids}`);
    await sequelize.query(`DELETE FROM audit_logs WHERE user_id IN ${ids} OR ip_address LIKE '198.51.100.%' OR ip_address LIKE '203.0.113.%'`);
    await sequelize.query("DELETE FROM users WHERE email LIKE 'sec_%@example.com'");
    // fichiers déposés pendant le test
    const f = path.join(__dirname, "..", "_sec_uploads.json");
    if (fs.existsSync(f)) {
      for (const url of JSON.parse(fs.readFileSync(f, "utf8")) as string[]) {
        const file = path.join(__dirname, "..", url.replace(/^\//, ""));
        if (file.includes(`${path.sep}uploads${path.sep}projects${path.sep}`) && fs.existsSync(file)) fs.unlinkSync(file);
      }
      fs.unlinkSync(f);
    }
    console.log("nettoyé");
  }
  await sequelize.close();
})();
