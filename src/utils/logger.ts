// Logger console minimal : horodatage + niveau + contexte.
// En production (Passenger), stdout/stderr finissent dans le log de l'application.
type Level = "INFO" | "WARN" | "ERROR";

function write(level: Level, context: string, message: string, extra?: unknown) {
  const line = `[${new Date().toISOString()}] ${level} [${context}] ${message}`;
  const out = level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
  if (extra === undefined) out(line);
  else out(line, extra);
}

export const logger = {
  info: (context: string, message: string, extra?: unknown) => write("INFO", context, message, extra),
  warn: (context: string, message: string, extra?: unknown) => write("WARN", context, message, extra),
  error: (context: string, message: string, extra?: unknown) => write("ERROR", context, message, extra),
};
