import {
  expectedGoogleDriveRootName,
  readStoredGoogleDriveConnection,
} from "@/lib/google-drive-connection";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const DRIVE_API_ENDPOINT = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

type GoogleDriveBindings = {
  GOOGLE_DRIVE_CLIENT_ID?: string;
  GOOGLE_DRIVE_CLIENT_SECRET?: string;
  GOOGLE_DRIVE_REFRESH_TOKEN?: string;
  GOOGLE_DRIVE_ROOT_FOLDER_ID?: string;
  GOOGLE_DRIVE_EXPECTED_ROOT_NAME?: string;
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
};

export type SafeDriveRootMetadata = {
  id: string;
  name: string;
  canAddChildren: boolean;
  locationType: "my_drive" | "shared_drive";
  webViewLink: string | null;
};

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
    rootFolderId: hasCompleteStaticConfiguration ? staticRootFolderId : stored?.rootFolderId || "",
    expectedRootName: expectedGoogleDriveRootName(),
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

export async function fetchGoogleDriveAccessToken() {
  const config = await configuredDriveCredentials();
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const payload = await readJson(response);
  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!response.ok || !accessToken) {
    throw new Error("GOOGLE_DRIVE_TOKEN_REFRESH_FAILED");
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
  const fields = "id,name,mimeType,trashed,driveId,webViewLink,capabilities(canAddChildren)";
  const response = await fetch(
    `${DRIVE_API_ENDPOINT}/files/${encodeURIComponent(normalizedFolderId)}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
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
  };
}
