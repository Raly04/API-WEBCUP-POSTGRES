// Masquage de données personnelles pour les journaux et les écrans de sécurité : on garde de quoi reconnaître une
// information (son propre appareil, sa propre adresse) sans exposer la valeur complète.

// awa.diallo@example.com -> a***@example.com
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

// 203.0.113.42 -> 203.0.113.x   |   2001:db8:abcd:1::7 -> 2001:db8:abcd::x   |   ::1 -> localhost
export function maskIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/i, "");
  if (v4 === "::1" || v4 === "127.0.0.1") return "localhost";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return v4.replace(/\.\d{1,3}$/, ".x");
  const groups = ip.split(":").filter(Boolean);
  return `${groups.slice(0, 3).join(":")}::x`;
}

// « Mozilla/5.0 (Windows NT 10.0; ...) Chrome/126... » -> « Chrome sur Windows »
export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return "Appareil inconnu";
  const browser =
    /Edg\//.test(userAgent) ? "Edge"
    : /OPR\/|Opera/.test(userAgent) ? "Opera"
    : /Firefox\//.test(userAgent) ? "Firefox"
    : /Chrome\//.test(userAgent) ? "Chrome"
    : /Safari\//.test(userAgent) ? "Safari"
    : /curl|PostmanRuntime|node|axios|undici/i.test(userAgent) ? "Application ou script"
    : "Navigateur";
  const system =
    /Windows/.test(userAgent) ? "Windows"
    : /Android/.test(userAgent) ? "Android"
    : /iPhone|iPad|iOS/.test(userAgent) ? "iOS"
    : /Mac OS X|Macintosh/.test(userAgent) ? "macOS"
    : /Linux/.test(userAgent) ? "Linux"
    : null;
  return system ? `${browser} sur ${system}` : browser;
}
