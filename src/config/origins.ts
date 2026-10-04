import "dotenv/config";

// CLIENT_URL accepte plusieurs origines séparées par des virgules
export const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
