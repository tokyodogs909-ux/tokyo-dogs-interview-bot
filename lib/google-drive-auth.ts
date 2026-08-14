import {
  expectedGoogleDriveRootName,
  readStoredGoogleDriveConnection,
} from "@/lib/google-drive-connection";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const DRIVE_API_ENDPOINT = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const GOOGLE_DRIVE_REQUEST_TIMEOUT_MS = 25_000;

async function fetchGoogleWithTimeout(url: string, init: RequestInit, errorCode: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_DRIVE_REQUEST_TIMEOUT_MS);
  const response = await fetch(url, { ...init, signal: controller.signal }).catch(() => {
    clearTimeout(timer);
    throw new Error(errorCode);
  });
  if (!response.body) {
    clearTimeout(timer);
    return response;
  }
  const finish = () => clearTimeout(timer);
  return new Proxy(response, {
    get(target, property) {
      if (["arrayBuffer", "blob", "formData", "json", "text"].includes(String(property))) {
        return async (...args: unknown[]) => {
          try {
            const method = Reflect.get(target, property, target) as (...methodArgs: unknown[]) => Promise<unknown>;
            return await method.apply(target, args);
          } finally { finish(); }
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

type GoogleDriveBindings = {
  GOOGLE_DRIVE_CLIENT_ID?: string;
  GOOGLE_DRIVE_CLIENT_SECRET?: string;
  GOOGLE_DRIVE_REFRESH_TOKEN?: string;
  GOOGLE_DRIVE_ROOT_FOLDER_ID?: string;
  GOOGLE_DRIVE_EXPECTED_ROOT_NAME?: string;
  GOOGLE_DRIVE_EXPECTED_ACCOUNT_EMAIL?: string;
};

type DriveFolderMetadata = {
  id?: string;
  name?: string;
  mimeType?: string;
  trashed?: boolean;
  driveId?: string;
  webViewLink?: string;
  capabilities?: {
    canAddChildren?: boolean;
  };
  permissions?: Array<{
    type?: string;
    role?: string;
    allowFileDiscovery?: boolean;
  }>;
};

type DriveAbout = {
  user?: {
    emailAddress?: string;
  };
};

export type SafeDriveRootMetadata = {
  id: string;
  name: string;
  canAddChildren: boolean;
  locationType: "my_drive" | "shared_drive";
  webViewLink: string | null;
  /** Display-only sharing risk. It never changes root readiness. */
  sharingRisk: "anyone_writer" | "anyone_reader" | "restricted" | "unknown";
};

function safeSharingRisk(folder: DriveFolderMetadata): SafeDriveRootMetadata["sharingRisk"] {
  if (!Array.isArray(folder.permissions)) return "unknown";
  const publicRoles = folder.permissions
    .filter((permission) => permission.type === "anyone")
    .map((permission) => permission.role);
  if (publicRoles.some((role) => role === "owner" || role === "organizer" || role === "fileOrganizer" || role === "writer")) {
    return "anyone_writer";
  }
  if (publicRoles.some((role) => role === "reader" || role === "commenter")) {
    return "anyone_reader";
  }
  return "restricted";
}

function bindings() {
  return (globalThis as typeof globalThis & {
    __TOKYO_DOGS_INTERVIEW_BINDINGS__?: GoogleDriveBindings;
  }).__TOKYO_DOGS_INTERVIEW_BINDINGS__ ?? {};
}

function setting(name: keyof GoogleDriveBindings) {
  const bound = bindings()[name];
  const local = typeof process === "undefined" ? undefined : process.env[name];
  return (bound ?? local ?? "").trim();
}

export function configuredGoogleDriveRootId() {
  return setting("GOOGLE_DRIVE_ROOT_FOLDER_ID");
}

export function expectedGoogleDriveAccountEmail() {
  return setting("GOOGLE_DRIVE_EXPECTED_ACCOUNT_EMAIL") || "tokyodogs909@gmail.com";
}

async function resolvedDriveConfiguration() {
  const staticRefreshToken = setting("GOOGLE_DRIVE_REFRESH_TOKEN");
  const staticRootFolderId = setting("GOOGLE_DRIVE_ROOT_FOLDER_ID");
  const hasCompleteStaticConfiguration = Boolean(staticRefreshToken && staticRootFolderId);
  const stored = hasCompleteStaticConfiguration
    ? null
    : await readStoredGoogleDriveConnection();
  return {
    clientId: setting("GOOGLE_DRIVE_CLIENT_ID"),
    clientSecret: setting("GOOGLE_DRIVE_CLIENT_SECRET"),
    refreshToken: hasCompleteStaticConfiguration ? staticRefreshToken : stored?.refreshToken || "",
    // An OAuth-created, app-managed destination is stored in D1 and takes
    // precedence over the legacy Sites setting. This keeps the non-sensitive
    // drive.file scope while avoiding a Google Picker dependency on mobile.
    rootFolderId: stored?.rootFolderId || staticRootFolderId || "",
    expectedRootName: stored?.rootFolderName || expectedGoogleDriveRootName(),
  };
}

export async function missingGoogleDriveConfiguration() {
  const config = await resolvedDriveConfiguration();
  return [
    ["GOOGLE_DRIVE_CLIENT_ID", config.clientId],
    ["GOOGLE_DRIVE_CLIENT_SECRET", config.clientSecret],
    ["GOOGLE_DRIVE_REFRESH_TOKEN", config.refreshToken],
    ["GOOGLE_DRIVE_ROOT_FOLDER_ID", config.rootFolderId],
  ].filter(([, value]) => !value).map(([name]) => name);
}

async function configuredDriveRoot() {
  const config = await resolvedDriveConfiguration();
  const missing = [
    ["GOOGLE_DRIVE_CLIENT_ID", config.clientId],
    ["GOOGLE_DRIVE_CLIENT_SECRET", config.clientSecret],
    ["GOOGLE_DRIVE_REFRESH_TOKEN", config.refreshToken],
    ["GOOGLE_DRIVE_ROOT_FOLDER_ID", config.rootFolderId],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`GOOGLE_DRIVE_CONFIGURATION_MISSING:${missing.join(",")}`);
  }
  return config;
}

async function configuredDriveCredentials() {
  const config = await resolvedDriveConfiguration();
  const missing = [
    ["GOOGLE_DRIVE_CLIENT_ID", config.clientId],
    ["GOOGLE_DRIVE_CLIENT_SECRET", config.clientSecret],
    ["GOOGLE_DRIVE_REFRESH_TOKEN", config.refreshToken],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`GOOGLE_DRIVE_CONFIGURATION_MISSING:${missing.join(",")}`);
  }
  return config;
}

async function readJson(response: Response) {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function fetchGoogleDriveAccountEmail(accessToken: string) {
  const response = await fetchGoogleWithTimeout(`${DRIVE_API_ENDPOINT}/about?fields=user(emailAddress)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, "GOOGLE_DRIVE_ACCOUNT_LOOKUP_FAILED");
  const about = await readJson(response) as DriveAbout;
  const email = about.user?.emailAddress?.trim().toLowerCase() ?? "";
  if (!response.ok || !email) throw new Error("GOOGLE_DRIVE_ACCOUNT_LOOKUP_FAILED");
  return email;
}

export async function fetchGoogleDriveAccessToken() {
  const config = await configuredDriveCredentials();
  const response = await fetchGoogleWithTimeout(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    }),
  }, "GOOGLE_DRIVE_TOKEN_REFRESH_TRANSIENT");
  const payload = await readJson(response);
  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!response.ok || !accessToken) {
    // invalid_grant, invalid_client, and other 4xx responses require an
    // administrator to reconnect Google Drive. Retrying those forever would
    // leave an archive looking "in progress" instead of surfacing the outage.
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new Error("GOOGLE_DRIVE_TOKEN_REFRESH_RECONNECT_REQUIRED");
    }
    throw new Error("GOOGLE_DRIVE_TOKEN_REFRESH_TRANSIENT");
  }
  return accessToken;
}

export async function validateGoogleDriveRoot(accessTokenOverride?: string): Promise<SafeDriveRootMetadata> {
  const config = await configuredDriveRoot();
  const accessToken = accessTokenOverride || await fetchGoogleDriveAccessToken();
  return validateGoogleDriveFolderSelection(config.rootFolderId, accessToken, config.expectedRootName);
}

export async function validateGoogleDriveFolderSelection(
  folderId: string,
  accessToken: string,
  expectedName = expectedGoogleDriveRootName(),
): Promise<SafeDriveRootMetadata> {
  const normalizedFolderId = folderId.trim();
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(normalizedFolderId)) {
    throw new Error("GOOGLE_DRIVE_ROOT_ID_INVALID");
  }
  const fields = "id,name,mimeType,trashed,driveId,webViewLink,capabilities(canAddChildren),permissions(type,role,allowFileDiscovery)";
  const response = await fetchGoogleWithTimeout(
    `${DRIVE_API_ENDPOINT}/files/${encodeURIComponent(normalizedFolderId)}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    "GOOGLE_DRIVE_ROOT_LOOKUP_FAILED",
  );
  const folder = await readJson(response) as DriveFolderMetadata;
  if (!response.ok) throw new Error("GOOGLE_DRIVE_ROOT_LOOKUP_FAILED");
  if (
    folder.id !== normalizedFolderId ||
    folder.name !== expectedName ||
    folder.mimeType !== FOLDER_MIME_TYPE ||
    folder.trashed === true
  ) {
    throw new Error("GOOGLE_DRIVE_ROOT_MISMATCH");
  }
  if (folder.capabilities?.canAddChildren !== true) {
    throw new Error("GOOGLE_DRIVE_ROOT_NOT_WRITABLE");
  }
  return {
    id: folder.id,
    name: folder.name,
    canAddChildren: true,
    locationType: folder.driveId ? "shared_drive" : "my_drive",
    webViewLink: typeof folder.webViewLink === "string" ? folder.webViewLink : null,
    sharingRisk: safeSharingRisk(folder),
  };
}

const MANAGED_ROOT_PROPERTY = "online-first-interview-v1";

function managedRootName() {
  return `${expectedGoogleDriveRootName()}_システム管理`;
}

function safeRootFromMetadata(folder: DriveFolderMetadata, expectedName: string): SafeDriveRootMetadata {
  if (
    !folder.id ||
    folder.name !== expectedName ||
    folder.mimeType !== FOLDER_MIME_TYPE ||
    folder.trashed === true
  ) {
    throw new Error("GOOGLE_DRIVE_ROOT_MISMATCH");
  }
  if (folder.capabilities?.canAddChildren !== true) {
    throw new Error("GOOGLE_DRIVE_ROOT_NOT_WRITABLE");
  }
  return {
    id: folder.id,
    name: folder.name,
    canAddChildren: true,
    locationType: folder.driveId ? "shared_drive" : "my_drive",
    webViewLink: typeof folder.webViewLink === "string" ? folder.webViewLink : null,
    sharingRisk: safeSharingRisk(folder),
  };
}

/**
 * drive.file cannot see an arbitrary pre-existing Drive folder unless it was
 * opened with this app through Google Picker. For the one-time production
 * setup we therefore create a narrowly scoped app-owned destination and store
 * its ID in D1. Repeated calls find the tagged folder instead of creating a
 * duplicate.
 */
export async function ensureGoogleDriveManagedRoot(accessToken: string): Promise<SafeDriveRootMetadata> {
  const name = managedRootName();
  const fields = "files(id,name,mimeType,trashed,driveId,webViewLink,capabilities(canAddChildren),permissions(type,role,allowFileDiscovery))";
  const query = new URLSearchParams({
    q: `trashed = false and mimeType = '${FOLDER_MIME_TYPE}' and appProperties has { key='tokyoDogsManagedRoot' and value='${MANAGED_ROOT_PROPERTY}' }`,
    pageSize: "10",
    spaces: "drive",
    fields,
  });
  const lookupResponse = await fetchGoogleWithTimeout(`${DRIVE_API_ENDPOINT}/files?${query}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, "GOOGLE_DRIVE_MANAGED_ROOT_LOOKUP_FAILED");
  const lookup = await readJson(lookupResponse) as { files?: DriveFolderMetadata[] };
  if (!lookupResponse.ok) throw new Error("GOOGLE_DRIVE_MANAGED_ROOT_LOOKUP_FAILED");
  const existing = lookup.files?.find((folder) => folder.name === name);
  if (existing) return safeRootFromMetadata(existing, name);

  const createResponse = await fetchGoogleWithTimeout(
    `${DRIVE_API_ENDPOINT}/files?fields=${encodeURIComponent("id,name,mimeType,trashed,driveId,webViewLink,capabilities(canAddChildren),permissions(type,role,allowFileDiscovery)")}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME_TYPE,
        appProperties: { tokyoDogsManagedRoot: MANAGED_ROOT_PROPERTY },
      }),
    },
    "GOOGLE_DRIVE_MANAGED_ROOT_CREATE_FAILED",
  );
  const created = await readJson(createResponse) as DriveFolderMetadata;
  if (!createResponse.ok) throw new Error("GOOGLE_DRIVE_MANAGED_ROOT_CREATE_FAILED");
  return safeRootFromMetadata(created, name);
}
