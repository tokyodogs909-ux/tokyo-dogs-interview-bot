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

export function missingGoogleDriveConfiguration() {
  const required: Array<keyof GoogleDriveBindings> = [
    "GOOGLE_DRIVE_CLIENT_ID",
    "GOOGLE_DRIVE_CLIENT_SECRET",
    "GOOGLE_DRIVE_REFRESH_TOKEN",
    "GOOGLE_DRIVE_ROOT_FOLDER_ID",
  ];
  return required.filter((name) => !setting(name));
}

function configuredDriveRoot() {
  const missing = missingGoogleDriveConfiguration();
  if (missing.length > 0) {
    throw new Error(`GOOGLE_DRIVE_CONFIGURATION_MISSING:${missing.join(",")}`);
  }
  return {
    clientId: setting("GOOGLE_DRIVE_CLIENT_ID"),
    clientSecret: setting("GOOGLE_DRIVE_CLIENT_SECRET"),
    refreshToken: setting("GOOGLE_DRIVE_REFRESH_TOKEN"),
    rootFolderId: setting("GOOGLE_DRIVE_ROOT_FOLDER_ID"),
    expectedRootName: setting("GOOGLE_DRIVE_EXPECTED_ROOT_NAME") || "オンライン一次面接_自動格納",
  };
}

async function readJson(response: Response) {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function fetchGoogleDriveAccessToken() {
  const config = configuredDriveRoot();
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
  const config = configuredDriveRoot();
  const accessToken = accessTokenOverride || await fetchGoogleDriveAccessToken();
  const fields = "id,name,mimeType,trashed,driveId,webViewLink,capabilities(canAddChildren)";
  const response = await fetch(
    `${DRIVE_API_ENDPOINT}/files/${encodeURIComponent(config.rootFolderId)}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  const folder = await readJson(response) as DriveFolderMetadata;
  if (!response.ok) throw new Error("GOOGLE_DRIVE_ROOT_LOOKUP_FAILED");
  if (
    folder.id !== config.rootFolderId ||
    folder.name !== config.expectedRootName ||
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

export function googleDriveRootFolderId() {
  return configuredDriveRoot().rootFolderId;
}
