const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

type GoogleDriveConnectionBindings = {
  DB?: D1Database;
  GOOGLE_DRIVE_CLIENT_ID?: string;
  GOOGLE_DRIVE_CLIENT_SECRET?: string;
  GOOGLE_DRIVE_OAUTH_REDIRECT_URI?: string;
  GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET?: string;
  GOOGLE_DRIVE_EXPECTED_ROOT_NAME?: string;
  GOOGLE_PICKER_API_KEY?: string;
  GOOGLE_CLOUD_PROJECT_NUMBER?: string;
};

type StoredConnectionRow = {
  refresh_token_ciphertext: string;
  refresh_token_iv: string;
  root_folder_id: string | null;
  root_folder_name: string | null;
  root_folder_url: string | null;
  scope: string;
};

export type StoredGoogleDriveConnection = {
  refreshToken: string;
  rootFolderId: string | null;
  rootFolderName: string | null;
  rootFolderUrl: string | null;
  scope: string;
};

function bindings() {
  return (globalThis as typeof globalThis & {
    __TOKYO_DOGS_INTERVIEW_BINDINGS__?: GoogleDriveConnectionBindings;
  }).__TOKYO_DOGS_INTERVIEW_BINDINGS__ ?? {};
}

function setting(name: keyof Omit<GoogleDriveConnectionBindings, "DB">) {
  const bound = bindings()[name];
  const local = typeof process === "undefined" ? undefined : process.env[name];
  return (bound ?? local ?? "").trim();
}

function database() {
  return bindings().DB;
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey() {
  const secret = setting("GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET");
  if (secret.length < 32) throw new Error("GOOGLE_DRIVE_ENCRYPTION_SECRET_MISSING");
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptRefreshToken(refreshToken: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(),
    new TextEncoder().encode(refreshToken),
  );
  return {
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    iv: toBase64Url(iv),
  };
}

async function decryptRefreshToken(ciphertext: string, iv: string) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(iv) },
    await encryptionKey(),
    fromBase64Url(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

async function ensureConnectionSchema(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS google_drive_connection (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    refresh_token_ciphertext TEXT NOT NULL,
    refresh_token_iv TEXT NOT NULL,
    root_folder_id TEXT,
    root_folder_name TEXT,
    root_folder_url TEXT,
    scope TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`).run();
}

export function googleDriveOAuthClientSettings() {
  const clientId = setting("GOOGLE_DRIVE_CLIENT_ID");
  const clientSecret = setting("GOOGLE_DRIVE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("GOOGLE_DRIVE_OAUTH_CLIENT_MISSING");
  return { clientId, clientSecret };
}

export function googleDriveOAuthRedirectUri(request: Request) {
  const configured = setting("GOOGLE_DRIVE_OAUTH_REDIRECT_URI");
  if (configured) return configured;
  const requestUrl = new URL(request.url);
  const forwardedHost = request.headers.get("X-Forwarded-Host")?.trim();
  const forwardedProto = request.headers.get("X-Forwarded-Proto") === "https" ? "https" : requestUrl.protocol.replace(":", "");
  const origin = forwardedHost && /^[a-z0-9.:[\]-]+$/i.test(forwardedHost)
    ? `${forwardedProto}://${forwardedHost}`
    : requestUrl.origin;
  return `${origin}/api/admin/google-drive/oauth/callback`;
}

export function googlePickerSettings() {
  const apiKey = setting("GOOGLE_PICKER_API_KEY");
  const projectNumber = setting("GOOGLE_CLOUD_PROJECT_NUMBER");
  if (!apiKey || !/^\d{6,20}$/.test(projectNumber)) throw new Error("GOOGLE_PICKER_CONFIGURATION_MISSING");
  return { apiKey, projectNumber };
}

export function expectedGoogleDriveRootName() {
  return setting("GOOGLE_DRIVE_EXPECTED_ROOT_NAME") || "オンライン一次面接_自動格納";
}

export function googleDriveScope() {
  return DRIVE_FILE_SCOPE;
}

export async function assertGoogleDriveConnectionStorageReady() {
  if (!database()) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await encryptionKey();
  googlePickerSettings();
}

export async function saveGoogleDriveRefreshToken(refreshToken: string) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const normalized = refreshToken.trim();
  if (normalized.length < 20 || normalized.length > 4096) throw new Error("GOOGLE_DRIVE_REFRESH_TOKEN_INVALID");
  await ensureConnectionSchema(db);
  const encrypted = await encryptRefreshToken(normalized);
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO google_drive_connection (
    id, refresh_token_ciphertext, refresh_token_iv, scope, created_at, updated_at
  ) VALUES (1, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    refresh_token_ciphertext = excluded.refresh_token_ciphertext,
    refresh_token_iv = excluded.refresh_token_iv,
    scope = excluded.scope,
    updated_at = excluded.updated_at`)
    .bind(encrypted.ciphertext, encrypted.iv, DRIVE_FILE_SCOPE, now, now)
    .run();
  const stored = await readStoredGoogleDriveConnection();
  if (!stored || stored.refreshToken !== normalized || stored.scope !== DRIVE_FILE_SCOPE) {
    throw new Error("GOOGLE_DRIVE_REFRESH_TOKEN_READBACK_MISMATCH");
  }
}

export async function saveGoogleDriveRoot(input: {
  id: string;
  name: string;
  webViewLink: string | null;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureConnectionSchema(db);
  const result = await db.prepare(`UPDATE google_drive_connection SET
    root_folder_id = ?, root_folder_name = ?, root_folder_url = ?, updated_at = ?
    WHERE id = 1`)
    .bind(input.id, input.name, input.webViewLink, new Date().toISOString())
    .run();
  if (Number(result.meta?.changes ?? 0) !== 1) throw new Error("GOOGLE_DRIVE_OAUTH_NOT_CONNECTED");
  const stored = await readStoredGoogleDriveConnection();
  if (
    !stored ||
    stored.rootFolderId !== input.id ||
    stored.rootFolderName !== input.name ||
    stored.rootFolderUrl !== input.webViewLink
  ) {
    throw new Error("GOOGLE_DRIVE_ROOT_READBACK_MISMATCH");
  }
}

export async function readStoredGoogleDriveConnection(): Promise<StoredGoogleDriveConnection | null> {
  const db = database();
  if (!db || !setting("GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET")) return null;
  await ensureConnectionSchema(db);
  const row = await db.prepare(`SELECT
    refresh_token_ciphertext, refresh_token_iv, root_folder_id, root_folder_name,
    root_folder_url, scope
    FROM google_drive_connection WHERE id = 1 LIMIT 1`)
    .first<StoredConnectionRow>();
  if (!row) return null;
  try {
    return {
      refreshToken: await decryptRefreshToken(row.refresh_token_ciphertext, row.refresh_token_iv),
      rootFolderId: row.root_folder_id,
      rootFolderName: row.root_folder_name,
      rootFolderUrl: row.root_folder_url,
      scope: row.scope,
    };
  } catch {
    throw new Error("GOOGLE_DRIVE_REFRESH_TOKEN_DECRYPT_FAILED");
  }
}
