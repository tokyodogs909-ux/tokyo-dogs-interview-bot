import assert from "node:assert/strict";
import test from "node:test";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("api-test", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);

const workerEnv = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const workerContext = {
  waitUntil() {},
  passThroughOnException() {},
};

function request(path, init, env = workerEnv) {
  return worker.fetch(new Request(`http://localhost${path}`, init), env, workerContext);
}

class FakeD1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    let changes = 0;
    if (this.sql.startsWith("INSERT INTO interview_sessions")) {
      const [id, accessTokenHash, candidateName, employment, preferredLocation, consentVersion,
        consentedAt, expiresAt, retentionUntil, createdAt, updatedAt] = this.values;
      if (this.sql.includes("WHERE EXISTS")) {
        const [nonceHash, comparedAt] = this.values.slice(11);
        const invite = this.database.invites.get(nonceHash);
        if (!invite || invite.used_at !== null || invite.expires_at <= comparedAt) {
          return { success: true, meta: { changes: 0 } };
        }
      }
      this.database.sessions.set(id, {
        id,
        access_token_hash: accessTokenHash,
        candidate_name: candidateName,
        employment,
        preferred_location: preferredLocation,
        consent_version: consentVersion,
        consented_at: consentedAt,
        status: "created",
        recording_status: "not_started",
        expires_at: expiresAt,
        retention_until: retentionUntil,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      changes = 1;
    } else if (this.sql.startsWith("INSERT INTO interview_invites")) {
      const [nonceHash, expiresAt] = this.values;
      this.database.invites.set(nonceHash, {
        nonce_hash: nonceHash,
        expires_at: expiresAt,
        used_at: null,
        session_id: null,
      });
      changes = 1;
    } else if (this.sql.startsWith("INSERT INTO interview_public_entries")) {
      const [id, sourceHash, candidateHash, createdAt, sourceToCount, sourceCutoff, sourceLimit,
        candidateToCount, candidateCutoff, candidateLimit] = this.values;
      const sourceCount = this.database.publicEntries.filter((entry) =>
        entry.source_hash === sourceToCount && entry.created_at > sourceCutoff).length;
      const candidateCount = this.database.publicEntries.filter((entry) =>
        entry.candidate_hash === candidateToCount && entry.created_at > candidateCutoff).length;
      if (sourceCount < sourceLimit && candidateCount < candidateLimit) {
        this.database.publicEntries.push({
          id,
          source_hash: sourceHash,
          candidate_hash: candidateHash,
          created_at: createdAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("DELETE FROM interview_public_entries")) {
      const [staleBefore] = this.values;
      const previousLength = this.database.publicEntries.length;
      this.database.publicEntries = this.database.publicEntries.filter((entry) => entry.created_at > staleBefore);
      changes = previousLength - this.database.publicEntries.length;
    } else if (this.sql.startsWith("UPDATE interview_invites SET used_at")) {
      const [usedAt, sessionId, nonceHash, comparedAt] = this.values;
      const invite = this.database.invites.get(nonceHash);
      if (invite && invite.used_at === null && invite.expires_at > comparedAt) {
        invite.used_at = usedAt;
        invite.session_id = sessionId;
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_invites SET session_id")) {
      const [sessionId, nonceHash] = this.values;
      const invite = this.database.invites.get(nonceHash);
      if (invite?.used_at) {
        invite.session_id = sessionId;
        changes = 1;
      }
    } else if (this.sql.startsWith("INSERT INTO interview_artifacts")) {
      this.database.artifacts.push(this.values);
      changes = 1;
    } else if (this.sql.startsWith("INSERT INTO interview_external_syncs")) {
      const [sessionId, requestedAt, updatedAt] = this.values;
      const current = this.database.externalSyncs.get(sessionId);
      const stillRunning = current?.status === "running";
      this.database.externalSyncs.set(sessionId, {
        provider: "google_drive",
        status: stillRunning ? "running" : "pending",
        requested_at: requestedAt,
        started_at: current?.started_at ?? null,
        completed_at: current?.completed_at ?? null,
        folder_id: current?.folder_id ?? null,
        folder_url: current?.folder_url ?? null,
        manifest_json: current?.manifest_json ?? null,
        error_code: current?.error_code ?? null,
        // A running claim keeps its own heartbeat; only a settled row is refreshed.
        updated_at: stillRunning ? current.updated_at : updatedAt,
      });
      changes = 1;
    } else if (this.sql.startsWith("UPDATE interview_external_syncs SET updated_at")) {
      const [updatedAt, sessionId, expectedStartedAt] = this.values;
      const sync = this.database.externalSyncs.get(sessionId);
      if (sync?.status === "running" && sync.started_at === expectedStartedAt) {
        sync.updated_at = updatedAt;
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_external_syncs SET status = 'running'")) {
      const [startedAt, updatedAt, sessionId] = this.values;
      const sync = this.database.externalSyncs.get(sessionId);
      if (sync?.status === "pending") {
        Object.assign(sync, {
          status: "running",
          started_at: startedAt,
          completed_at: null,
          error_code: null,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_external_syncs SET status = 'pending'")) {
      const [updatedAt, sessionId, staleBefore] = this.values;
      const sync = this.database.externalSyncs.get(sessionId);
      if (sync?.status === "running" && sync.started_at && sync.updated_at <= staleBefore) {
        Object.assign(sync, {
          status: "pending",
          started_at: null,
          completed_at: null,
          error_code: null,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_external_syncs SET status = CASE")) {
      const [startedAtForStatus, , completedAt, folderId, folderUrl, manifestJson,
        updatedAt, sessionId, expectedStartedAt] = this.values;
      const sync = this.database.externalSyncs.get(sessionId);
      if (sync?.started_at === expectedStartedAt) {
        const retry = sync.requested_at > startedAtForStatus;
        Object.assign(sync, {
          status: retry ? "pending" : "completed",
          completed_at: retry ? null : completedAt,
          folder_id: folderId,
          folder_url: folderUrl,
          manifest_json: manifestJson,
          error_code: null,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_external_syncs SET status = 'failed'")) {
      const [errorCode, updatedAt, sessionId, expectedStartedAt] = this.values;
      const sync = this.database.externalSyncs.get(sessionId);
      if (sync?.started_at === expectedStartedAt) {
        Object.assign(sync, { status: "failed", error_code: errorCode, updated_at: updatedAt });
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_sessions SET recording_status")) {
      const [, id] = this.values;
      const session = this.database.sessions.get(id);
      if (session) session.recording_status = "stored";
    } else if (this.sql.startsWith("UPDATE interview_sessions SET status = 'evaluation_pending'")) {
      const [transcriptJson, updatedAt, id] = this.values;
      const session = this.database.sessions.get(id);
      if (session) Object.assign(session, { status: "evaluation_pending", transcript_json: transcriptJson, updated_at: updatedAt });
    } else if (this.sql.startsWith("UPDATE interview_sessions SET status = 'completed'")) {
      const [transcriptJson, evaluationJson, summary, completedAt, updatedAt, id] = this.values;
      const session = this.database.sessions.get(id);
      if (session && session.status !== "completed") {
        Object.assign(session, {
          status: "completed",
          transcript_json: transcriptJson,
          evaluation_json: evaluationJson,
          summary,
          completed_at: completedAt,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("INSERT INTO interview_human_reviews")) {
      const [, sessionId, reviewerName, videoScoresJson, overallNote, , updatedAt] = this.values;
      this.database.humanReviews.set(`${sessionId}:${reviewerName}`, {
        reviewer_name: reviewerName,
        video_scores_json: videoScoresJson,
        overall_note: overallNote,
        updated_at: updatedAt,
      });
    } else if (
      this.sql.startsWith("INSERT INTO interview_audit_events") &&
      this.sql.includes("VALUES (?, ?, ?, 'candidate', ?)")
    ) {
      const [, sessionId, eventType, detailJson] = this.values;
      this.database.auditEvents.push({
        event_type: eventType,
        detail_json: detailJson,
        created_at: new Date().toISOString(),
        session_id: sessionId,
      });
    } else if (this.sql.startsWith("INSERT INTO google_drive_connection")) {
      const [ciphertext, iv, scope, createdAt, updatedAt] = this.values;
      this.database.driveConnection = {
        refresh_token_ciphertext: ciphertext,
        refresh_token_iv: iv,
        root_folder_id: this.database.driveConnection?.root_folder_id ?? null,
        root_folder_name: this.database.driveConnection?.root_folder_name ?? null,
        root_folder_url: this.database.driveConnection?.root_folder_url ?? null,
        scope,
        created_at: this.database.driveConnection?.created_at ?? createdAt,
        updated_at: updatedAt,
      };
      changes = 1;
    } else if (this.sql.startsWith("UPDATE google_drive_connection SET")) {
      if (this.database.driveConnection) {
        const [folderId, folderName, folderUrl, updatedAt] = this.values;
        Object.assign(this.database.driveConnection, {
          root_folder_id: folderId,
          root_folder_name: folderName,
          root_folder_url: folderUrl,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    }
    return { success: true, meta: { changes } };
  }

  async first() {
    if (this.sql.startsWith("SELECT used_at, expires_at FROM interview_invites")) {
      const invite = this.database.invites.get(this.values[0]);
      return invite ? { used_at: invite.used_at, expires_at: invite.expires_at } : null;
    }
    if (this.sql.startsWith("SELECT id, access_token_hash")) {
      return this.database.sessions.get(this.values[0]) ?? null;
    }
    if (this.sql.startsWith("SELECT id, candidate_name, employment, preferred_location")) {
      return this.database.sessions.get(this.values[0]) ?? null;
    }
    if (this.sql.startsWith("SELECT id FROM interview_sessions")) {
      const session = this.database.sessions.get(this.values[0]);
      return session ? { id: session.id } : null;
    }
    if (this.sql.startsWith("SELECT object_key, content_type, byte_size")) {
      const sessionId = this.values[0];
      const values = this.database.artifacts.find((item) => item[1] === sessionId);
      return values ? { object_key: values[2], content_type: values[3], byte_size: values[4] } : null;
    }
    if (this.sql.startsWith("SELECT provider, status, requested_at")) {
      return this.database.externalSyncs.get(this.values[0]) ?? null;
    }
    if (this.sql.startsWith("SELECT refresh_token_ciphertext")) {
      return this.database.driveConnection;
    }
    return null;
  }

  async all() {
    if (this.sql.startsWith("PRAGMA table_info(interview_sessions)")) {
      return { results: [{ name: "candidate_name" }] };
    }
    if (this.sql.startsWith("SELECT reviewer_name, video_scores_json")) {
      const sessionId = this.values[0];
      return {
        results: [...this.database.humanReviews.entries()]
          .filter(([key]) => key.startsWith(`${sessionId}:`))
          .map(([, value]) => value),
      };
    }
    if (this.sql.startsWith("SELECT event_type, detail_json, created_at")) {
      const technicalEventTypes = new Set([
        "audio_playback_blocked", "transcription_failed", "recording_unavailable",
        "connection_failed", "candidate_requested_stop",
      ]);
      return {
        results: this.database.auditEvents.filter((event) =>
          event.session_id === this.values[0] && technicalEventTypes.has(event.event_type)),
      };
    }
    return { results: [] };
  }

}

class FakeD1 {
  constructor() {
    this.sessions = new Map();
    this.artifacts = [];
    this.humanReviews = new Map();
    this.auditEvents = [];
    this.invites = new Map();
    this.publicEntries = [];
    this.externalSyncs = new Map();
    this.driveConnection = null;
  }

  prepare(sql) {
    return new FakeD1Statement(this, sql);
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

class FakeR2 {
  constructor() {
    this.objects = new Map();
  }

  async put(key, body, options) {
    this.objects.set(key, { body, options });
    return { etag: "test-etag" };
  }

  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { body: object.body, etag: "test-etag" };
  }

}

async function createTestInterviewSession(env, employment = "正社員", location = "越谷店") {
  const response = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment, location, consent: true }),
  }, env);
  assert.equal(response.status, 201);
  return response.json();
}

test("health endpoint reports server credential presence without returning the key", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const response = await request("/api/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: true });
  assert.equal(response.headers.get("permissions-policy"), "camera=(self), microphone=(self), display-capture=(self)");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("Google Drive admin health check fails closed without secrets or authorization", async () => {
  const unauthorized = await request("/api/admin/google-drive/health", {}, {
    ...workerEnv,
    INTERVIEW_ADMIN_TOKEN: "drive-admin-secret",
  });
  assert.equal(unauthorized.status, 401);

  const unconfigured = await request("/api/admin/google-drive/health", {
    headers: { Authorization: "Bearer drive-admin-secret" },
  }, {
    ...workerEnv,
    INTERVIEW_ADMIN_TOKEN: "drive-admin-secret",
  });
  const payload = await unconfigured.json();
  assert.equal(unconfigured.status, 503);
  assert.equal(payload.configured, false);
  assert.equal(payload.authenticated, false);
  assert.ok(payload.missing.includes("GOOGLE_DRIVE_REFRESH_TOKEN"));
  assert.equal(JSON.stringify(payload).includes("drive-admin-secret"), false);
});

test("Google Drive admin health check refreshes OAuth and verifies only the approved writable folder", async () => {
  const originalFetch = globalThis.fetch;
  const rootFolderId = "10z2FVOAv_MXGlfgxfsO-VgC_41v3Ui3T";
  let tokenRequestBody = "";
  try {
    globalThis.fetch = async (url, init = {}) => {
      if (url === "https://oauth2.googleapis.com/token") {
        tokenRequestBody = String(init.body);
        assert.equal(init.method, "POST");
        return Response.json({ access_token: "temporary-google-access-token", expires_in: 3600 });
      }
      assert.match(String(url), new RegExp(`/drive/v3/files/${rootFolderId}`));
      assert.equal(init.headers.Authorization, "Bearer temporary-google-access-token");
      return Response.json({
        id: rootFolderId,
        name: "オンライン一次面接_自動格納",
        mimeType: "application/vnd.google-apps.folder",
        trashed: false,
        capabilities: { canAddChildren: true },
        webViewLink: `https://drive.google.com/drive/folders/${rootFolderId}`,
      });
    };
    const response = await request("/api/admin/google-drive/health", {
      headers: { Authorization: "Bearer drive-admin-secret" },
    }, {
      ...workerEnv,
      INTERVIEW_ADMIN_TOKEN: "drive-admin-secret",
      GOOGLE_DRIVE_CLIENT_ID: "google-client-id",
      GOOGLE_DRIVE_CLIENT_SECRET: "google-client-secret",
      GOOGLE_DRIVE_REFRESH_TOKEN: "google-refresh-token",
      GOOGLE_DRIVE_ROOT_FOLDER_ID: rootFolderId,
      GOOGLE_DRIVE_EXPECTED_ROOT_NAME: "オンライン一次面接_自動格納",
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.configured, true);
    assert.equal(payload.authenticated, true);
    assert.equal(payload.root.id, rootFolderId);
    assert.equal(payload.root.name, "オンライン一次面接_自動格納");
    assert.equal(payload.root.canAddChildren, true);
    assert.equal(payload.root.locationType, "my_drive");
    assert.match(tokenRequestBody, /grant_type=refresh_token/);
    assert.match(tokenRequestBody, /client_id=google-client-id/);
    const responseText = JSON.stringify(payload);
    assert.equal(responseText.includes("google-client-secret"), false);
    assert.equal(responseText.includes("google-refresh-token"), false);
    assert.equal(responseText.includes("temporary-google-access-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Google Drive setup starts with PKCE and grants a short-lived HttpOnly admin session", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    INTERVIEW_ADMIN_TOKEN: "drive-admin-secret",
    GOOGLE_DRIVE_CLIENT_ID: "google-client-id",
    GOOGLE_DRIVE_CLIENT_SECRET: "google-client-secret",
    GOOGLE_DRIVE_OAUTH_REDIRECT_URI: "http://localhost/api/admin/google-drive/oauth/callback",
    GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET: "test-only-encryption-material-over-32-characters",
    GOOGLE_PICKER_API_KEY: "public-picker-browser-key",
    GOOGLE_CLOUD_PROJECT_NUMBER: "123456789012",
  };
  const response = await request("/api/admin/google-drive/oauth/start", {
    method: "POST",
    headers: {
      Authorization: "Bearer drive-admin-secret",
      Origin: "http://localhost",
    },
  }, env);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  const authorizationUrl = new URL(payload.authorizationUrl);
  assert.equal(authorizationUrl.origin, "https://accounts.google.com");
  assert.equal(authorizationUrl.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.file");
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorizationUrl.searchParams.get("code_challenge"));
  assert.ok(authorizationUrl.searchParams.get("state"));
  const setCookies = response.headers.getSetCookie();
  assert.equal(setCookies.some((value) => value.startsWith("td_drive_admin_setup=")), true);
  assert.equal(setCookies.some((value) => value.startsWith("td_drive_oauth_state=")), true);
  assert.equal(setCookies.some((value) => value.startsWith("td_drive_oauth_verifier=")), true);
  assert.equal(setCookies.every((value) => value.includes("HttpOnly") && value.includes("SameSite=Lax")), true);
  const responseText = JSON.stringify(payload) + setCookies.join(";");
  assert.equal(responseText.includes("google-client-secret"), false);
  assert.equal(responseText.includes("drive-admin-secret"), false);
});

test("Google Drive setup session can mint only a short-lived Picker token and invalid callbacks fail closed", async () => {
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const rootFolderId = "10z2FVOAv_MXGlfgxfsO-VgC_41v3Ui3T";
  const env = {
    ...workerEnv,
    DB: database,
    INTERVIEW_ADMIN_TOKEN: "drive-admin-secret",
    GOOGLE_DRIVE_CLIENT_ID: "google-client-id",
    GOOGLE_DRIVE_CLIENT_SECRET: "google-client-secret",
    GOOGLE_DRIVE_REFRESH_TOKEN: "google-refresh-token",
    GOOGLE_DRIVE_ROOT_FOLDER_ID: rootFolderId,
    GOOGLE_DRIVE_OAUTH_REDIRECT_URI: "http://localhost/api/admin/google-drive/oauth/callback",
    GOOGLE_PICKER_API_KEY: "public-picker-browser-key",
    GOOGLE_CLOUD_PROJECT_NUMBER: "123456789012",
    GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET: "test-only-encryption-material-over-32-characters",
  };
  try {
    const start = await request("/api/admin/google-drive/oauth/start", {
      method: "POST",
      headers: { Authorization: "Bearer drive-admin-secret", Origin: "http://localhost" },
    }, env);
    const setupCookie = start.headers.getSetCookie()
      .find((value) => value.startsWith("td_drive_admin_setup="))
      ?.split(";", 1)[0];
    assert.ok(setupCookie);
    globalThis.fetch = async (url) => {
      assert.equal(url, "https://oauth2.googleapis.com/token");
      return Response.json({ access_token: "temporary-google-access-token", expires_in: 3600 });
    };
    const token = await request("/api/admin/google-drive/oauth/token", {
      headers: { Cookie: setupCookie },
    }, env);
    const tokenPayload = await token.json();
    assert.equal(token.status, 200, JSON.stringify(tokenPayload));
    assert.equal(tokenPayload.accessToken, "temporary-google-access-token");
    assert.equal(tokenPayload.projectNumber, "123456789012");
    assert.equal(JSON.stringify(tokenPayload).includes("google-client-secret"), false);
    assert.equal(JSON.stringify(tokenPayload).includes("google-refresh-token"), false);

    const invalidCallback = await request("/api/admin/google-drive/oauth/callback?code=unused&state=invalid", {}, env);
    assert.equal(invalidCallback.status, 303);
    assert.equal(new URL(invalidCallback.headers.get("location")).pathname, "/staff/google-drive");
    assert.equal(new URL(invalidCallback.headers.get("location")).searchParams.get("error"), "oauth_failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Google Drive OAuth callback encrypts the refresh token and the approved folder is read back", async () => {
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const rootFolderId = "10z2FVOAv_MXGlfgxfsO-VgC_41v3Ui3T";
  const env = {
    ...workerEnv,
    DB: database,
    INTERVIEW_ADMIN_TOKEN: "drive-admin-secret",
    GOOGLE_DRIVE_CLIENT_ID: "google-client-id",
    GOOGLE_DRIVE_CLIENT_SECRET: "google-client-secret",
    GOOGLE_DRIVE_OAUTH_REDIRECT_URI: "http://localhost/api/admin/google-drive/oauth/callback",
    GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET: "test-only-encryption-material-over-32-characters",
    GOOGLE_PICKER_API_KEY: "public-picker-browser-key",
    GOOGLE_CLOUD_PROJECT_NUMBER: "123456789012",
    GOOGLE_DRIVE_EXPECTED_ROOT_NAME: "オンライン一次面接_自動格納",
  };
  try {
    const start = await request("/api/admin/google-drive/oauth/start", {
      method: "POST",
      headers: { Authorization: "Bearer drive-admin-secret", Origin: "http://localhost" },
    }, env);
    const startPayload = await start.json();
    const authorizationUrl = new URL(startPayload.authorizationUrl);
    const state = authorizationUrl.searchParams.get("state");
    const cookieHeader = start.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const setupCookie = cookieHeader.split("; ").find((value) => value.startsWith("td_drive_admin_setup="));
    assert.ok(state);
    assert.ok(setupCookie);

    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (href === "https://oauth2.googleapis.com/token") {
        const body = new URLSearchParams(String(init.body));
        if (body.get("grant_type") === "authorization_code") {
          assert.equal(body.get("code"), "authorization-code-from-google");
          assert.ok(body.get("code_verifier"));
          return Response.json({
            refresh_token: "stored-google-refresh-token-never-returned",
            scope: "https://www.googleapis.com/auth/drive.file",
          });
        }
        assert.equal(body.get("grant_type"), "refresh_token");
        assert.equal(body.get("refresh_token"), "stored-google-refresh-token-never-returned");
        return Response.json({ access_token: "temporary-google-access-token", expires_in: 3600 });
      }
      if (href.includes(`/drive/v3/files/${rootFolderId}`)) {
        assert.equal(init.headers.Authorization, "Bearer temporary-google-access-token");
        return Response.json({
          id: rootFolderId,
          name: "オンライン一次面接_自動格納",
          mimeType: "application/vnd.google-apps.folder",
          trashed: false,
          capabilities: { canAddChildren: true },
          webViewLink: `https://drive.google.com/drive/folders/${rootFolderId}`,
        });
      }
      throw new Error(`Unexpected Google request: ${href}`);
    };

    const callback = await request(`/api/admin/google-drive/oauth/callback?code=authorization-code-from-google&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: cookieHeader },
    }, env);
    assert.equal(callback.status, 303);
    assert.equal(new URL(callback.headers.get("location")).searchParams.get("connected"), "1");
    assert.ok(database.driveConnection);
    assert.notEqual(database.driveConnection.refresh_token_ciphertext, "stored-google-refresh-token-never-returned");
    assert.equal(JSON.stringify(database.driveConnection).includes("stored-google-refresh-token-never-returned"), false);

    const rootResponse = await request("/api/admin/google-drive/root", {
      method: "POST",
      headers: {
        Cookie: setupCookie,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ folderId: rootFolderId }),
    }, env);
    const rootPayload = await rootResponse.json();
    assert.equal(rootResponse.status, 200, JSON.stringify(rootPayload));
    assert.equal(rootPayload.saved, true);
    assert.equal(rootPayload.root.id, rootFolderId);
    assert.equal(database.driveConnection.root_folder_id, rootFolderId);
    assert.equal(database.driveConnection.root_folder_name, "オンライン一次面接_自動格納");
    assert.equal(JSON.stringify(rootPayload).includes("temporary-google-access-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("completed interview archive creates candidate folders and stores recording, transcript, evaluation, and PDF", async () => {
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const recordings = new FakeR2();
  const rootFolderId = "10z2FVOAv_MXGlfgxfsO-VgC_41v3Ui3T";
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: recordings,
    INTERVIEW_ADMIN_TOKEN: "interview-admin-secret",
    GOOGLE_DRIVE_CLIENT_ID: "google-client-id",
    GOOGLE_DRIVE_CLIENT_SECRET: "google-client-secret",
    GOOGLE_DRIVE_REFRESH_TOKEN: "google-refresh-token",
    GOOGLE_DRIVE_ROOT_FOLDER_ID: rootFolderId,
    GOOGLE_DRIVE_EXPECTED_ROOT_NAME: "オンライン一次面接_自動格納",
  };
  const session = await createTestInterviewSession(env, "正社員", "越谷店・相談可");
  const stored = database.sessions.get(session.sessionId);
  stored.status = "completed";
  stored.completed_at = "2026-07-29T03:00:00.000Z";
  stored.transcript_json = JSON.stringify([
    { id: "turn-1", speaker: "interviewer", text: "自己紹介をお願いします。", createdAt: "2026-07-29T02:50:00.000Z" },
    { id: "turn-2", speaker: "candidate", text: "接客経験があります。", createdAt: "2026-07-29T02:50:10.000Z" },
  ]);
  stored.evaluation_json = JSON.stringify({
    recommendation: "human_review",
    summary: "採用担当者による確認が必要です。",
    dimensions: [],
    strengths: ["接客経験"],
    concerns: [],
    contradictions: [],
    missingTopics: ["勤務開始時期"],
    conditions: ["他店舗配属は相談"],
    evidenceValidationWarnings: [],
    humanReviewRequired: true,
  });
  stored.summary = "採用担当者による確認が必要です。";
  const recordingKey = `interviews/${session.sessionId}/recording.webm`;
  const recordingBytes = new TextEncoder().encode("test-recording-with-both-audio-tracks");
  recordings.objects.set(recordingKey, {
    body: new Blob([recordingBytes], { type: "video/webm" }).stream(),
    options: { httpMetadata: { contentType: "video/webm" } },
  });
  database.artifacts.push([
    "artifact-id",
    session.sessionId,
    recordingKey,
    "video/webm",
    recordingBytes.byteLength,
    "test-etag",
    "manual-deletion-only-policy-pending",
  ]);
  database.externalSyncs.set(session.sessionId, {
    provider: "google_drive",
    status: "running",
    requested_at: "2026-07-29T02:00:00.000Z",
    started_at: "2026-07-29T02:00:00.000Z",
    completed_at: null,
    folder_id: null,
    folder_url: null,
    manifest_json: null,
    error_code: null,
    updated_at: "2026-07-29T02:00:00.000Z",
  });

  let nextFile = 0;
  const uploadedNames = [];
  const createdFolders = [];
  const uploadedDriveFiles = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (href === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "temporary-google-access-token", expires_in: 3600 });
      }
      if (href.includes(`/drive/v3/files/${rootFolderId}?`)) {
        return Response.json({
          id: rootFolderId,
          name: "オンライン一次面接_自動格納",
          mimeType: "application/vnd.google-apps.folder",
          trashed: false,
          capabilities: { canAddChildren: true },
          webViewLink: `https://drive.google.com/drive/folders/${rootFolderId}`,
        });
      }
      if (href.includes("/drive/v3/files/folder-3?")) {
        return Response.json({
          id: "folder-3",
          name: `テスト 応募者_${session.sessionId}`,
          mimeType: "application/vnd.google-apps.folder",
          trashed: false,
          parents: ["folder-2"],
          appProperties: {
            tokyoDogsKind: "tokyoDogsInterviewSession",
            tokyoDogsInterviewSession: session.sessionId,
          },
          webViewLink: "https://drive.google.com/drive/folders/folder-3",
        });
      }
      if (href.startsWith("https://www.googleapis.com/drive/v3/files?") && init.method !== "POST") {
        return Response.json({ files: uploadedDriveFiles.length === 6 ? uploadedDriveFiles : [] });
      }
      if (href.startsWith("https://www.googleapis.com/drive/v3/files?") && init.method === "POST") {
        const metadata = JSON.parse(String(init.body));
        const id = `folder-${++nextFile}`;
        createdFolders.push(metadata.name);
        return Response.json({
          id,
          name: metadata.name,
          mimeType: metadata.mimeType,
          parents: metadata.parents,
          appProperties: metadata.appProperties,
          webViewLink: `https://drive.google.com/drive/folders/${id}`,
        });
      }
      if (href.includes("/export?")) {
        return new Response(new TextEncoder().encode("%PDF-1.7 test report"), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      }
      if (href.includes("uploadType=resumable")) {
        const metadata = JSON.parse(String(init.body));
        uploadedNames.push(metadata.name);
        uploadedDriveFiles.push({
          id: `file-${nextFile + 1}`,
          name: metadata.name,
          size: String(recordingBytes.byteLength),
          parents: metadata.parents,
          appProperties: metadata.appProperties,
        });
        return new Response(null, {
          status: 200,
          headers: { Location: "https://upload.example.test/recording-session" },
        });
      }
      if (href === "https://upload.example.test/recording-session") {
        assert.equal(init.method, "PUT");
        assert.equal(init.headers["Content-Length"], String(recordingBytes.byteLength));
        return Response.json({
          id: `file-${++nextFile}`,
          name: `${session.sessionId}_面接録画.webm`,
          size: String(recordingBytes.byteLength),
        });
      }
      if (href.includes("uploadType=multipart")) {
        const metadataBlob = init.body.get("metadata");
        const metadata = JSON.parse(await metadataBlob.text());
        uploadedNames.push(metadata.name);
        const mediaBlob = init.body.get("media");
        const uploadedFile = {
          id: `file-${++nextFile}`,
          name: metadata.name,
          mimeType: metadata.mimeType || mediaBlob.type,
          size: String(mediaBlob.size),
          parents: metadata.parents,
          appProperties: metadata.appProperties,
        };
        uploadedDriveFiles.push(uploadedFile);
        return Response.json(uploadedFile);
      }
      throw new Error(`Unexpected Drive request: ${href}`);
    };

    const response = await request("/api/admin/google-drive/sync", {
      method: "POST",
      headers: {
        Authorization: "Bearer interview-admin-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId: session.sessionId }),
    }, env);
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify({ payload, sync: database.externalSyncs.get(session.sessionId), uploadedNames, createdFolders }));
    assert.equal(payload.synced, true);
    assert.equal(payload.result.recordingIncluded, true);
    assert.match(payload.result.folderUrl, /^https:\/\/drive\.google\.com\/drive\/folders\/folder-/);
    assert.deepEqual(createdFolders, ["2026", "07", `テスト 応募者_${session.sessionId}`]);
    assert.deepEqual(new Set(uploadedNames), new Set([
      `${session.sessionId}_文字起こし.txt`,
      `${session.sessionId}_評価データ.json`,
      `${session.sessionId}_オンライン一次面接レポート`,
      `${session.sessionId}_オンライン一次面接レポート.pdf`,
      `${session.sessionId}_面接録画.webm`,
      `${session.sessionId}_格納結果.json`,
    ]));
    assert.equal(database.externalSyncs.get(session.sessionId).status, "completed");
    assert.notEqual(database.externalSyncs.get(session.sessionId).started_at, "2026-07-29T02:00:00.000Z");
    const responseText = JSON.stringify(payload);
    assert.equal(responseText.includes("google-client-secret"), false);
    assert.equal(responseText.includes("google-refresh-token"), false);
    assert.equal(responseText.includes("temporary-google-access-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("production invite links are admin-only, expire, and can create exactly one interview session", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    INTERVIEW_ADMIN_TOKEN: "interview-admin-secret",
    INTERVIEW_INVITE_SIGNING_SECRET: "test-signing-secret-with-sufficient-entropy",
    INTERVIEW_REQUIRE_SIGNED_INVITE: "true",
  };

  const unauthorized = await request("/api/admin/interviews/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresInHours: 24 }),
  }, env);
  assert.equal(unauthorized.status, 401);

  const issue = await request("/api/admin/interviews/invite", {
    method: "POST",
    headers: {
      Authorization: "Bearer interview-admin-secret",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresInHours: 24 }),
  }, env);
  const issued = await issue.json();
  assert.equal(issue.status, 201);
  assert.match(issued.link, /^http:\/\/localhost\/\?invite=/);
  assert.ok(Date.parse(issued.expiresAt) > Date.now());
  assert.equal(JSON.stringify(issued).includes("interview-admin-secret"), false);
  assert.equal(JSON.stringify(issued).includes("test-signing-secret"), false);
  const inviteToken = new URL(issued.link).searchParams.get("invite");
  assert.ok(inviteToken);

  const missingInvite = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateName: "招待なし", employment: "正社員", location: "越谷店", consent: true }),
  }, env);
  assert.equal(missingInvite.status, 403);

  const create = () => request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidateName: "招待済み 候補者",
      employment: "正社員",
      location: "越谷店、または他店舗相談",
      consent: true,
      inviteToken,
    }),
  }, env);
  const accepted = await create();
  const acceptedPayload = await accepted.json();
  assert.equal(accepted.status, 201);
  assert.ok(database.sessions.has(acceptedPayload.sessionId));
  assert.equal([...database.invites.values()][0].session_id, acceptedPayload.sessionId);

  const reused = await create();
  const reusedPayload = await reused.json();
  assert.equal(reused.status, 403);
  assert.equal(reusedPayload.status, "used");
  assert.match(reusedPayload.error, /使用済み/);
  assert.equal(database.sessions.size, 1);
});

test("required invite mode fails closed when the signing secret is not configured", async () => {
  const database = new FakeD1();
  const response = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "越谷店", consent: true }),
  }, {
    ...workerEnv,
    DB: database,
    INTERVIEW_REQUIRE_SIGNED_INVITE: "true",
  });
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.status, "signing-unavailable");
  assert.match(payload.error, /受付準備が完了していません/);
  assert.equal(database.sessions.size, 0);
});

test("invite pre-flight blocks the fixed top URL before camera and microphone permission", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    INTERVIEW_ADMIN_TOKEN: "interview-admin-secret",
    INTERVIEW_INVITE_SIGNING_SECRET: "test-signing-secret-with-sufficient-entropy",
    INTERVIEW_REQUIRE_SIGNED_INVITE: "true",
  };

  // The fixed top URL a candidate reaches without their personal link.
  const noToken = await request("/api/interviews/invite", undefined, env);
  const noTokenPayload = await noToken.json();
  assert.equal(noToken.status, 403);
  assert.equal(noTokenPayload.status, "missing");
  assert.match(noTokenPayload.error, /専用のリンクを開いてください/);

  const forged = await request("/api/interviews/invite?token=not-a-real-token", undefined, env);
  const forgedPayload = await forged.json();
  assert.equal(forged.status, 403);
  assert.equal(forgedPayload.status, "invalid");

  const issue = await request("/api/admin/interviews/invite", {
    method: "POST",
    headers: { Authorization: "Bearer interview-admin-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ expiresInHours: 24 }),
  }, env);
  const inviteToken = new URL((await issue.json()).link).searchParams.get("invite");

  const valid = await request(`/api/interviews/invite?token=${encodeURIComponent(inviteToken)}`, undefined, env);
  const validPayload = await valid.json();
  assert.equal(valid.status, 200);
  assert.equal(validPayload.status, "ok");
  assert.equal(validPayload.inviteRequired, true);
  // Pre-flight must not hand out anything usable or consume the invite.
  assert.equal(validPayload.sessionId, undefined);
  assert.equal(validPayload.accessToken, undefined);
  assert.equal([...database.invites.values()][0].used_at, null);

  // Once the invite is consumed, the same link reports "used" rather than "invalid".
  await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidateName: "招待済み 候補者",
      employment: "正社員",
      location: "越谷店",
      consent: true,
      inviteToken,
    }),
  }, env);
  const used = await request(`/api/interviews/invite?token=${encodeURIComponent(inviteToken)}`, undefined, env);
  const usedPayload = await used.json();
  assert.equal(used.status, 403);
  assert.equal(usedPayload.status, "used");
});

test("invite pre-flight separates operator-side gaps and never names internal settings", async () => {
  const signingMissing = await request("/api/interviews/invite?token=abc.def", undefined, {
    ...workerEnv,
    DB: new FakeD1(),
    INTERVIEW_REQUIRE_SIGNED_INVITE: "true",
  });
  const signingPayload = await signingMissing.json();
  assert.equal(signingMissing.status, 503);
  assert.equal(signingPayload.status, "signing-unavailable");

  // Signing configured and the link itself is genuine, but no storage binding is
  // available to look the invite up.
  const signingEnv = {
    ...workerEnv,
    DB: new FakeD1(),
    INTERVIEW_ADMIN_TOKEN: "interview-admin-secret",
    INTERVIEW_INVITE_SIGNING_SECRET: "test-signing-secret-with-sufficient-entropy",
    INTERVIEW_REQUIRE_SIGNED_INVITE: "true",
  };
  const issue = await request("/api/admin/interviews/invite", {
    method: "POST",
    headers: { Authorization: "Bearer interview-admin-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ expiresInHours: 24 }),
  }, signingEnv);
  const genuineToken = new URL((await issue.json()).link).searchParams.get("invite");
  const storageMissing = await request(`/api/interviews/invite?token=${encodeURIComponent(genuineToken)}`, undefined, {
    ...workerEnv,
    INTERVIEW_INVITE_SIGNING_SECRET: "test-signing-secret-with-sufficient-entropy",
    INTERVIEW_REQUIRE_SIGNED_INVITE: "true",
  });
  const storagePayload = await storageMissing.json();
  assert.equal(storageMissing.status, 503);
  assert.equal(storagePayload.status, "storage-unavailable");
  assert.match(storagePayload.error, /保存領域を準備できませんでした/);

  for (const payload of [signingPayload, storagePayload]) {
    const text = JSON.stringify(payload);
    assert.equal(/INTERVIEW_|DB|RECORDINGS|OPENAI/.test(text), false);
  }
});

test("connection check stays available on the fixed URL while signed invites are required", async () => {
  const env = {
    ...workerEnv,
    DB: new FakeD1(),
    INTERVIEW_INVITE_SIGNING_SECRET: "test-signing-secret-with-sufficient-entropy",
    INTERVIEW_REQUIRE_SIGNED_INVITE: "true",
  };
  // The connection check is client-only, so the portal itself must still be served
  // on the fixed URL even though no interview can be started from it.
  const page = await request("/", { headers: { accept: "text/html" } }, env);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /接続確認（選考対象外）/);
});

test("invite pre-flight opens up only when signed invites are not required", async () => {
  const response = await request("/api/interviews/invite", undefined, { ...workerEnv, DB: new FakeD1() });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.status, "ok");
  assert.equal(payload.inviteRequired, false);
});

test("common entry URL creates separate sessions and throttles repeated paid starts", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    INTERVIEW_ADMIN_TOKEN: "test-admin-secret",
    INTERVIEW_INVITE_SIGNING_SECRET: "test-signing-secret-with-sufficient-entropy",
    INTERVIEW_REQUIRE_SIGNED_INVITE: "false",
  };
  const start = (candidateName, address = "203.0.113.10") => request("/api/interviews/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": address,
      "User-Agent": "TOKYO-DOGS-COMMON-ENTRY-TEST",
    },
    body: JSON.stringify({
      candidateName,
      employment: "正社員",
      location: "越谷店",
      consent: true,
    }),
  }, env);

  const first = await start("共通 一郎");
  const second = await start("共通 二郎");
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const firstPayload = await first.json();
  const secondPayload = await second.json();
  assert.notEqual(firstPayload.sessionId, secondPayload.sessionId);
  assert.notEqual(firstPayload.accessToken, secondPayload.accessToken);
  assert.equal(database.publicEntries.length, 2);
  assert.equal("source_address" in database.publicEntries[0], false);
  assert.doesNotMatch(JSON.stringify(database.publicEntries), /203\.0\.113|共通/);

  assert.equal((await start("同一 応募者", "203.0.113.11")).status, 201);
  assert.equal((await start("同一 応募者", "203.0.113.11")).status, 201);
  assert.equal((await start("同一 応募者", "203.0.113.11")).status, 201);
  const throttled = await start("同一 応募者", "203.0.113.11");
  assert.equal(throttled.status, 429);
  assert.match((await throttled.json()).error, /6時間/);

  for (let index = 0; index < 8; index += 1) {
    assert.equal((await start(`接続元制限 ${index}`, "203.0.113.12")).status, 201);
  }
  const sourceThrottled = await start("接続元制限 9", "203.0.113.12");
  assert.equal(sourceThrottled.status, 429);

  const issuedResponse = await request("/api/admin/interviews/invite", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-admin-secret",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresInHours: 24 }),
  }, env);
  assert.equal(issuedResponse.status, 201);
  const individualToken = new URL((await issuedResponse.json()).link).searchParams.get("invite");
  const individual = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidateName: "個別 招待者",
      employment: "正社員",
      location: "越谷店",
      consent: true,
      inviteToken: individualToken,
    }),
  }, env);
  assert.equal(individual.status, 201);
  const reused = await request(`/api/interviews/invite?token=${encodeURIComponent(individualToken)}`, undefined, env);
  assert.equal(reused.status, 403);
  assert.equal((await reused.json()).status, "used");
});

test("invite pre-flight rejects cross-origin callers", async () => {
  const response = await request("/api/interviews/invite", {
    headers: { Origin: "https://attacker.example" },
  }, {
    ...workerEnv,
    DB: new FakeD1(),
    INTERVIEW_INVITE_SIGNING_SECRET: "test-signing-secret-with-sufficient-entropy",
    INTERVIEW_REQUIRE_SIGNED_INVITE: "true",
  });
  assert.equal(response.status, 403);
});

test("candidate can freely enter one or more preferred work locations and the server normalizes them", async () => {
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const response = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidateName: "テスト 応募者",
      employment: "正社員",
      location: "  新宿エリア   または越谷店（配属相談希望）  ",
      consent: true,
    }),
  }, env);
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(
    database.sessions.get(payload.sessionId).preferred_location,
    "新宿エリア または越谷店(配属相談希望)",
  );

  const missing = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "   ", consent: true }),
  }, env);
  assert.equal(missing.status, 400);

  const tooLong = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "店".repeat(121), consent: true }),
  }, env);
  assert.equal(tooLong.status, 400);
});

test("interview session stores the candidate name and protects the recording with a one-time bearer token", async () => {
  process.env.INTERVIEW_REVIEW_TOKEN_KASAMA = "kasama-review-secret";
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = { ...workerEnv, DB: database, RECORDINGS: recordings };
  const sessionResponse = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidateName: "山田 花子",
      employment: "正社員",
      location: "越谷店",
      consent: true,
    }),
  }, env);
  const session = await sessionResponse.json();
  assert.equal(sessionResponse.status, 201);
  assert.match(session.sessionId, /^TD-[A-Z0-9-]{6,40}$/);
  assert.equal(typeof session.accessToken, "string");
  assert.ok(session.accessToken.length > 20);
  assert.notEqual(database.sessions.get(session.sessionId).access_token_hash, session.accessToken);
  assert.equal(database.sessions.get(session.sessionId).candidate_name, "山田 花子");
  assert.equal(session.storagePolicy, "manual-deletion-only-policy-pending");
  assert.equal(database.sessions.get(session.sessionId).retention_until, "manual-deletion-only-policy-pending");
  database.sessions.get(session.sessionId).status = "in_progress";

  const recordingBody = new TextEncoder().encode("small-webm-fixture");
  const uploadResponse = await request("/api/interviews/recording", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
      "Content-Type": "video/webm",
      "Content-Length": String(recordingBody.byteLength),
    },
    body: recordingBody,
  }, env);
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 200);
  assert.equal(upload.stored, true);
  assert.equal("objectKey" in upload, false);
  const storedObjectKey = `interviews/${session.sessionId}/recording.webm`;
  assert.equal(recordings.objects.has(storedObjectKey), true);
  assert.equal(recordings.objects.get(storedObjectKey).options.customMetadata.storagePolicy, "manual-deletion-only-policy-pending");
  assert.equal(database.sessions.get(session.sessionId).recording_status, "stored");

  const unauthorized = await request("/api/interviews/recording", {
    method: "POST",
    headers: {
      "X-Interview-Session": session.sessionId,
      "Content-Type": "video/webm",
      "Content-Length": String(recordingBody.byteLength),
    },
    body: recordingBody,
  }, env);
  assert.equal(unauthorized.status, 401);
  assert.equal(worker.scheduled, undefined);
  assert.equal(recordings.objects.has(storedObjectKey), true);

  const protectedRecording = await request(`/api/staff/recording?sessionId=${session.sessionId}`, {}, env);
  assert.equal(protectedRecording.status, 401);
  const staffRecording = await request(`/api/staff/recording?sessionId=${session.sessionId}`, {
    headers: {
      Authorization: "Bearer kasama-review-secret",
      "X-Interview-Reviewer": "kasama",
    },
  }, env);
  assert.equal(staffRecording.status, 200);
  assert.equal(staffRecording.headers.get("content-type"), "video/webm");
  assert.equal(await staffRecording.text(), "small-webm-fixture");
});

test("recording upload survives one transient D1 failure after the R2 object is already stored", async () => {
  process.env.INTERVIEW_REVIEW_TOKEN_KASAMA = "kasama-review-secret";
  class FlakyD1 extends FakeD1 {
    constructor() {
      super();
      this.artifactBatchAttempts = 0;
    }

    async batch(statements) {
      if (statements.some((statement) => statement.sql.startsWith("INSERT INTO interview_artifacts"))) {
        this.artifactBatchAttempts += 1;
        if (this.artifactBatchAttempts === 1) throw new Error("D1_TRANSIENT_TEST_FAILURE");
      }
      return super.batch(statements);
    }
  }
  const database = new FlakyD1();
  const recordings = new FakeR2();
  const env = { ...workerEnv, DB: database, RECORDINGS: recordings };
  const sessionResponse = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "越谷店", consent: true }),
  }, env);
  const session = await sessionResponse.json();
  database.sessions.get(session.sessionId).status = "in_progress";

  const recordingBody = new TextEncoder().encode("small-webm-fixture");
  const storedObjectKey = `interviews/${session.sessionId}/recording.webm`;
  const uploadResponse = await request("/api/interviews/recording", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
      "Content-Type": "video/webm",
      "Content-Length": String(recordingBody.byteLength),
    },
    body: recordingBody,
  }, env);
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 200);
  assert.equal(upload.stored, true);
  assert.equal(database.artifactBatchAttempts, 2);
  // The R2 object must not be re-uploaded or lost across the retry: it was already
  // durably stored before the first (failing) D1 write attempt.
  assert.equal(recordings.objects.has(storedObjectKey), true);
  assert.equal(database.sessions.get(session.sessionId).recording_status, "stored");
  assert.equal(database.artifacts.some((row) => row[2] === storedObjectKey), true);
});

test("candidate technical incidents are audited and cross-origin mutations are rejected", async () => {
  process.env.INTERVIEW_REVIEW_TOKEN_KASAMA = "kasama-review-secret";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const rejected = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "越谷店", consent: true }),
  }, env);
  assert.equal(rejected.status, 403);

  // A spoofed X-Forwarded-Host must not be able to make an attacker's own Origin pass
  // the same-origin check, since it is an ordinary header any cross-origin fetch() can set.
  const spoofed = await request("/api/interviews/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://attacker.example",
      "X-Forwarded-Host": "attacker.example",
      "X-Forwarded-Proto": "https",
    },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "越谷店", consent: true }),
  }, env);
  assert.equal(spoofed.status, 403);

  const session = await createTestInterviewSession(env);
  const incident = await request("/api/interviews/event", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
      Origin: "http://localhost",
    },
    body: JSON.stringify({
      sessionId: session.sessionId,
      eventType: "transcription_failed",
      code: "TRANSCRIPTION_FAILED",
    }),
  }, env);
  assert.equal(incident.status, 200);
  assert.equal(database.auditEvents.some((event) => event.event_type === "transcription_failed"), true);

  const staffResponse = await request(`/api/staff/interview?sessionId=${session.sessionId}`, {
    headers: {
      Authorization: "Bearer kasama-review-secret",
      "X-Interview-Reviewer": "kasama",
    },
  }, env);
  const staffPayload = await staffResponse.json();
  assert.equal(staffResponse.status, 200);
  assert.equal(staffPayload.review.technicalEvents[0].type, "transcription_failed");
});

test("realtime endpoint mints a short-lived token with the interview safety settings", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const session = await createTestInterviewSession(env);
  const originalFetch = globalThis.fetch;
  let capturedBody;
  let capturedAuthorization;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/realtime/client_secrets");
      capturedBody = JSON.parse(init.body);
      capturedAuthorization = init.headers.Authorization;
      return Response.json({
        value: "ek_test_ephemeral",
        expires_at: 9999999999,
        session: { model: "gpt-realtime-2.1" },
      });
    };

    const response = await request("/api/realtime/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({
        sessionId: session.sessionId,
        employment: "正社員",
        location: "越谷店",
      }),
    }, env);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.value, "ek_test_ephemeral");
    assert.equal(payload.model, "gpt-realtime-2.1");
    assert.equal(capturedAuthorization, "Bearer test-key-never-returned");
    assert.equal(capturedBody.session.audio.input.turn_detection.type, "semantic_vad");
    assert.equal(capturedBody.session.audio.input.turn_detection.eagerness, "low");
    assert.equal(capturedBody.session.audio.input.turn_detection.create_response, false);
    assert.equal(capturedBody.session.audio.input.turn_detection.interrupt_response, false);
    assert.equal(capturedBody.session.max_output_tokens, 1400);
    assert.match(capturedBody.session.instructions, /退職・転職を考えた理由/);
    assert.match(capturedBody.session.instructions, /なぜそれをやろうと思ったのですか/);
    assert.match(capturedBody.session.instructions, /決め手は何でしたか/);
    assert.match(capturedBody.session.instructions, /私の理解が合っているか/);
    assert.match(capturedBody.session.instructions, /長い回答は/);
    assert.match(capturedBody.session.instructions, /ドッグトレーナー、ペット業界の中でも東京DOGS/);
    assert.match(capturedBody.session.instructions, /清掃、安全管理、飼い主対応、記録、報告/);
    assert.match(capturedBody.session.instructions, /既存資料の「違和感」は自動不採用に使わない/);
    assert.match(capturedBody.session.instructions, /笑顔の有無/);
    assert.match(capturedBody.session.instructions, /傾聴、理解確認/);
    assert.match(capturedBody.session.instructions, /犬を通して、人々を幸せに/);
    assert.match(capturedBody.session.instructions, /仕事選びの基準は、まず本人の言葉で三つ/);
    assert.match(capturedBody.session.instructions, /希望店舗以外への配属や他店舗ヘルプが実際に発生する可能性/);
    assert.match(capturedBody.session.instructions, /普通自動車免許、送迎、当直/);
    assert.match(capturedBody.session.instructions, /通常数日〜1週間、長い場合は10日程度/);
    assert.match(capturedBody.session.instructions, /既存資料の「両親の反応」「家族構成」「家族間の仲」「住まい」は質問しない/);
    assert.doesNotMatch(capturedBody.session.instructions, /笠間・山本・松尾/);
    assert.equal(capturedBody.session.tools[0].name, "complete_interview");
    assert.deepEqual(
      capturedBody.session.tools[0].parameters.properties.topics_covered.items.enum,
      Array.from({ length: 15 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`),
    );
    assert.doesNotMatch(JSON.stringify(payload), /test-key-never-returned/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("realtime endpoint distinguishes missing quota from temporary congestion", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const session = await createTestInterviewSession(env);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json(
      { error: { type: "insufficient_quota", code: "insufficient_quota" } },
      { status: 429 },
    );
    const response = await request("/api/realtime/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({
        sessionId: session.sessionId,
        employment: "正社員",
        location: "越谷店",
      }),
    }, env);
    const payload = await response.json();
    assert.equal(response.status, 429);
    assert.match(payload.error, /オンライン一次面接の接続設定が完了していません/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("realtime token endpoint never bypasses interview authentication when storage is unavailable", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const originalFetch = globalThis.fetch;
  let upstreamCalled = false;
  try {
    globalThis.fetch = async () => {
      upstreamCalled = true;
      return Response.json({ value: "must-not-be-issued" });
    };
    const response = await request("/api/realtime/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "TD-TEST-ABC123",
        employment: "正社員",
        location: "越谷店",
      }),
    });
    assert.equal(response.status, 401);
    assert.equal(upstreamCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("same-origin realtime call authorizes the exact new interview session and proxies SDP", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const sessionResponse = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "越谷店", consent: true }),
  }, env);
  const session = await sessionResponse.json();
  const originalFetch = globalThis.fetch;
  let capturedSession;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/realtime/calls");
      assert.equal(init.headers.Authorization, "Bearer test-key-never-returned");
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.get("sdp"), "v=0\r\no=test-offer\r\n");
      capturedSession = JSON.parse(init.body.get("session"));
      return new Response("v=0\r\no=test-answer\r\n", {
        status: 200,
        headers: { "Content-Type": "application/sdp" },
      });
    };
    const response = await request("/api/realtime/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/sdp",
        "X-Interview-Session": session.sessionId,
      },
      body: "v=0\r\no=test-offer\r\n",
    }, env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/sdp");
    assert.equal(await response.text(), "v=0\r\no=test-answer\r\n");
    assert.equal(capturedSession.model, "gpt-realtime-2.1");
    assert.equal(capturedSession.audio.input.turn_detection.type, "semantic_vad");

    const rejected = await request("/api/realtime/call", {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-session-token",
        "Content-Type": "application/sdp",
        "X-Interview-Session": session.sessionId,
      },
      body: "v=0\r\no=test-offer\r\n",
    }, env);
    assert.equal(rejected.status, 401);
    assert.match(await rejected.text(), /TD-CONN-AUTH/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const dimensionNames = [
  "理念・志望動機",
  "素直さ・改善行動",
  "責任感・誠実性",
  "接客・対話力",
  "学習意欲・継続力",
  "犬と人への安全配慮",
  "勤務条件の適合性",
];

const candidateTurns = dimensionNames.map((name, index) => ({
  id: `candidate-${index + 1}`,
  speaker: "candidate",
  createdAt: new Date(2026, 6, 29, 9, index).toISOString(),
  text: `${name}について、私は状況を確認し、周囲へ報告してから具体的に行動しました。その結果を振り返り、次回の改善策まで決めて継続しました。`,
}));

function modelEvaluation({ invalidEvidence = false } = {}) {
  return {
    recommendation: "job_related_evidence_complete",
    summary: "職務に関連する具体的な経験を確認できました。",
    dimensions: dimensionNames.map((name, index) => ({
      name,
      score: 4,
      confidence: "medium",
      rationale: "具体的な行動と改善を説明しています。",
      evidence: [{
        quote: invalidEvidence && index === 0
          ? "文字起こしに存在しない引用"
          : candidateTurns[index].text.slice(0, 42),
        turnId: candidateTurns[index].id,
        relevance: "本人の行動を示す回答です。",
      }],
    })),
    strengths: ["改善行動を具体的に説明した"],
    concerns: [],
    contradictions: [],
    missingTopics: [],
    conditions: ["勤務条件は採用担当者が最終確認する"],
  };
}

async function runEvaluationApi(invalidEvidence, transform = (value) => value) {
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = { ...workerEnv, DB: database, RECORDINGS: recordings };
  const sessionResponse = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "越谷店", consent: true }),
  }, env);
  const session = await sessionResponse.json();
  database.sessions.get(session.sessionId).status = "in_progress";
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      const body = JSON.parse(init.body);
      assert.equal(body.store, false);
      assert.equal(body.model, "gpt-5.6-sol");
      assert.equal(body.text.format.strict, true);
      assert.match(body.instructions, /総合評価は過去応募者との順位比較ではなく/);
      assert.match(body.instructions, /部活経験の有無そのものは評価しない/);
      return Response.json({
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify(transform(modelEvaluation({ invalidEvidence }))),
          }],
        }],
      });
    };
    const response = await request("/api/evaluate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({
        sessionId: session.sessionId,
        employment: "正社員",
        location: "越谷店",
        transcript: candidateTurns,
      }),
    }, env);
    return { response, database, env, session };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("candidate evaluation endpoint stores a verified result without disclosing it", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  process.env.INTERVIEW_REVIEW_TOKEN_KASAMA = "kasama-review-secret";
  const { response, env, session } = await runEvaluationApi(false);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.stored, true);
  assert.equal(payload.humanReviewRequired, true);
  assert.equal("evaluation" in payload, false);

  const unauthorized = await request(`/api/staff/interview?sessionId=${session.sessionId}`, {}, env);
  assert.equal(unauthorized.status, 401);
  const staffResponse = await request(`/api/staff/interview?sessionId=${session.sessionId}`, {
    headers: {
      Authorization: "Bearer kasama-review-secret",
      "X-Interview-Reviewer": "kasama",
    },
  }, env);
  const staffPayload = await staffResponse.json();
  assert.equal(staffResponse.status, 200);
  assert.equal(staffPayload.review.evaluation.recommendation, "job_related_evidence_complete");
  assert.equal(staffPayload.review.evaluation.evidenceValidationWarnings.length, 0);
  assert.equal(staffPayload.review.evaluation.dimensions.every((item) => item.evidence[0].verified), true);
  assert.deepEqual(staffPayload.review.authorizedReviewers, ["笠間", "山本"]);

  const videoScores = [
    { name: "接客時の傾聴・姿勢・態度", score: 4, note: "相手の話を遮らず理解を確認した" },
    { name: "接客ロールプレイの進行", score: 4, note: "挨拶、要望確認、説明の順で進行した" },
    { name: "安全説明の具体性", score: 5, note: "犬と人の距離を取り、独断せず相談すると説明した" },
    { name: "相手への配慮と分かりやすさ", score: 4, note: "飼い主を責めず、専門用語を言い換えて説明した" },
  ];
  const saveReview = await request("/api/staff/review", {
    method: "POST",
    headers: {
      Authorization: "Bearer kasama-review-secret",
      "X-Interview-Reviewer": "kasama",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId: session.sessionId, scores: videoScores, overallNote: "人による確認" }),
  }, env);
  assert.equal(saveReview.status, 200);
  const refreshed = await request(`/api/staff/interview?sessionId=${session.sessionId}`, {
    headers: {
      Authorization: "Bearer kasama-review-secret",
      "X-Interview-Reviewer": "kasama",
    },
  }, env);
  const refreshedPayload = await refreshed.json();
  assert.equal(refreshedPayload.review.humanReviews[0].reviewerName, "笠間");
  assert.equal(refreshedPayload.review.humanReviews[0].videoScores.length, 4);
});

test("staff-only evaluation drops invented evidence and forces human review", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  process.env.INTERVIEW_REVIEW_TOKEN_KASAMA = "kasama-review-secret";
  const { response, env, session } = await runEvaluationApi(true);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal("evaluation" in payload, false);
  const staffResponse = await request(`/api/staff/interview?sessionId=${session.sessionId}`, {
    headers: {
      Authorization: "Bearer kasama-review-secret",
      "X-Interview-Reviewer": "kasama",
    },
  }, env);
  const staffPayload = await staffResponse.json();
  assert.equal(staffPayload.review.evaluation.recommendation, "human_review");
  assert.equal(staffPayload.review.evaluation.dimensions[0].score, null);
  assert.equal(staffPayload.review.evaluation.dimensions[0].evidence.length, 0);
  assert.ok(staffPayload.review.evaluation.evidenceValidationWarnings.length >= 1);
});

test("evaluation prose naming a prohibited attribute or blaming the equipment is flagged, not rewritten", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  process.env.INTERVIEW_REVIEW_TOKEN_KASAMA = "kasama-review-secret";
  const { response, env, session } = await runEvaluationApi(false, (evaluation) => ({
    ...evaluation,
    summary: "国籍と家族構成の話題が出ましたが、職務経験は確認できました。",
    concerns: ["回線が不安定でカメラ映像が乱れたため、印象を確認しづらかった。"],
  }));
  assert.equal(response.status, 200);

  const staffResponse = await request(`/api/staff/interview?sessionId=${session.sessionId}`, {
    headers: { Authorization: "Bearer kasama-review-secret", "X-Interview-Reviewer": "kasama" },
  }, env);
  const evaluation = (await staffResponse.json()).review.evaluation;
  const warnings = evaluation.evidenceValidationWarnings.join("\n");
  assert.match(warnings, /職務と無関係な属性/);
  assert.match(warnings, /国籍/);
  assert.match(warnings, /家族構成/);
  assert.match(warnings, /機器・通信・外見/);
  assert.match(warnings, /回線/);
  assert.match(warnings, /カメラ/);
  // A flagged evaluation is never auto-decided: it is routed to human review.
  assert.equal(evaluation.recommendation, "human_review");
  assert.equal(evaluation.humanReviewRequired, true);
  // Detection only. Rewriting or dropping the sentence would hide the very text a
  // recruiter has to re-read, and would risk deleting a legitimate one on a false match.
  assert.equal(evaluation.summary, "国籍と家族構成の話題が出ましたが、職務経験は確認できました。");
  assert.equal(evaluation.concerns[0], "回線が不安定でカメラ映像が乱れたため、印象を確認しづらかった。");
});

test("concurrent evaluation submissions for the same session never both report success", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = { ...workerEnv, DB: database, RECORDINGS: recordings };
  const sessionResponse = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "越谷店", consent: true }),
  }, env);
  const session = await sessionResponse.json();
  database.sessions.get(session.sessionId).status = "in_progress";
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  try {
    globalThis.fetch = async () => {
      callCount += 1;
      // Both requests pass the route's early "session not yet completed" check before
      // either one's model call resolves, reproducing the race where two submissions
      // for the same session reach saveInterviewEvaluation concurrently. The first
      // fetch call resolves last so both handlers are guaranteed to be in flight at once.
      await new Promise((resolve) => setTimeout(resolve, callCount === 1 ? 20 : 0));
      return Response.json({
        output: [{
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(modelEvaluation({ invalidEvidence: false })) }],
        }],
      });
    };
    const submit = () => request("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({
        sessionId: session.sessionId,
        employment: "正社員",
        location: "越谷店",
        transcript: candidateTurns,
      }),
    }, env);
    const [first, second] = await Promise.all([submit(), submit()]);
    // Exactly one submission must be treated as authoritative; the other must be
    // rejected instead of silently no-oping while still claiming success.
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(database.sessions.get(session.sessionId).status, "completed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const DRIVE_ROOT_FOLDER_ID = "10z2FVOAv_MXGlfgxfsO-VgC_41v3Ui3T";

function driveSyncEnv(database) {
  return {
    ...workerEnv,
    DB: database,
    INTERVIEW_ADMIN_TOKEN: "interview-admin-secret",
    GOOGLE_DRIVE_CLIENT_ID: "google-client-id",
    GOOGLE_DRIVE_CLIENT_SECRET: "google-client-secret",
    GOOGLE_DRIVE_REFRESH_TOKEN: "google-refresh-token",
    GOOGLE_DRIVE_ROOT_FOLDER_ID: DRIVE_ROOT_FOLDER_ID,
    GOOGLE_DRIVE_EXPECTED_ROOT_NAME: "オンライン一次面接_自動格納",
  };
}

async function seedCompletedInterview(env, database) {
  const session = await createTestInterviewSession(env, "正社員", "越谷店");
  const stored = database.sessions.get(session.sessionId);
  stored.status = "completed";
  stored.completed_at = "2026-07-29T03:00:00.000Z";
  stored.transcript_json = JSON.stringify([
    { id: "turn-1", speaker: "candidate", text: "接客経験があります。", createdAt: "2026-07-29T02:50:10.000Z" },
  ]);
  stored.evaluation_json = JSON.stringify({
    recommendation: "human_review",
    summary: "採用担当者による確認が必要です。",
    dimensions: [],
    strengths: [],
    concerns: [],
    contradictions: [],
    missingTopics: [],
    conditions: [],
    evidenceValidationWarnings: [],
    humanReviewRequired: true,
  });
  return session;
}

function requestAdminSync(sessionId, env) {
  return request("/api/admin/google-drive/sync", {
    method: "POST",
    headers: { Authorization: "Bearer interview-admin-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  }, env);
}

test("a Google Drive archive still reporting progress is never restarted underneath itself", async () => {
  // Two workers archiving the same interview both create the candidate folder and
  // both upload each artifact, so Drive ends up with duplicates and the read-back
  // check rejects the archive. Reclaiming the claim is therefore only allowed once
  // the owner has gone silent for the whole stale window, not merely once it has
  // been running that long.
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const env = driveSyncEnv(database);
  const session = await seedCompletedInterview(env, database);
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1_000).toISOString();
  database.externalSyncs.set(session.sessionId, {
    provider: "google_drive",
    status: "running",
    requested_at: thirtyMinutesAgo,
    started_at: thirtyMinutesAgo,
    completed_at: null,
    folder_id: null,
    folder_url: null,
    manifest_json: null,
    error_code: null,
    // The owning worker reported progress a moment ago: it is slow, not dead.
    updated_at: new Date().toISOString(),
  });

  let driveCalls = 0;
  try {
    globalThis.fetch = async () => {
      driveCalls += 1;
      throw new Error("a second worker must never reach Google Drive");
    };
    const response = await requestAdminSync(session.sessionId, env);
    assert.equal(response.status, 502);
    assert.equal(driveCalls, 0, "the live archive must not be duplicated by a second worker");
    const sync = database.externalSyncs.get(session.sessionId);
    assert.equal(sync.status, "running");
    assert.equal(sync.started_at, thirtyMinutesAgo, "the live claim must stay with its owner");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a Google Drive archive that stopped reporting progress is reclaimed", async () => {
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const env = driveSyncEnv(database);
  const session = await seedCompletedInterview(env, database);
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1_000).toISOString();
  database.externalSyncs.set(session.sessionId, {
    provider: "google_drive",
    status: "running",
    requested_at: thirtyMinutesAgo,
    started_at: thirtyMinutesAgo,
    completed_at: null,
    folder_id: null,
    folder_url: null,
    manifest_json: null,
    error_code: null,
    // No heartbeat for the whole stale window: the worker is gone.
    updated_at: thirtyMinutesAgo,
  });

  try {
    globalThis.fetch = async (url) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "temporary-google-access-token", expires_in: 3600 });
      }
      // Stop the reclaimed run at the approved-root check so the test asserts the
      // reclaim itself rather than a full archive.
      return Response.json({
        id: DRIVE_ROOT_FOLDER_ID,
        name: "別のフォルダ",
        mimeType: "application/vnd.google-apps.folder",
        trashed: false,
        capabilities: { canAddChildren: true },
      });
    };
    const response = await requestAdminSync(session.sessionId, env);
    assert.equal(response.status, 502);
    const sync = database.externalSyncs.get(session.sessionId);
    assert.equal(sync.status, "failed", "the abandoned claim must be taken over and settled");
    assert.notEqual(sync.started_at, thirtyMinutesAgo);
    assert.equal(sync.error_code, "GOOGLE_DRIVE_ROOT_MISMATCH");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a Google Drive worker that loses its claim stops before duplicating candidate files", async () => {
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const env = driveSyncEnv(database);
  const session = await seedCompletedInterview(env, database);
  const uploadedNames = [];
  let nextFile = 0;
  let reclaimed = false;

  try {
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (href === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "temporary-google-access-token", expires_in: 3600 });
      }
      if (href.includes(`/drive/v3/files/${DRIVE_ROOT_FOLDER_ID}?`)) {
        return Response.json({
          id: DRIVE_ROOT_FOLDER_ID,
          name: "オンライン一次面接_自動格納",
          mimeType: "application/vnd.google-apps.folder",
          trashed: false,
          capabilities: { canAddChildren: true },
        });
      }
      if (href.startsWith("https://www.googleapis.com/drive/v3/files?") && init.method !== "POST") {
        return Response.json({ files: [] });
      }
      if (href.startsWith("https://www.googleapis.com/drive/v3/files?") && init.method === "POST") {
        const metadata = JSON.parse(String(init.body));
        const id = `folder-${++nextFile}`;
        return Response.json({
          id,
          name: metadata.name,
          mimeType: metadata.mimeType,
          parents: metadata.parents,
          appProperties: metadata.appProperties,
          webViewLink: `https://drive.google.com/drive/folders/${id}`,
        });
      }
      if (href.includes("uploadType=multipart")) {
        const metadata = JSON.parse(await init.body.get("metadata").text());
        uploadedNames.push(metadata.name);
        if (!reclaimed) {
          // Another worker takes the claim while this upload is in flight.
          reclaimed = true;
          database.externalSyncs.get(session.sessionId).started_at = "2099-01-01T00:00:00.000Z";
        }
        return Response.json({ id: `file-${++nextFile}`, name: metadata.name, size: "10" });
      }
      throw new Error(`Unexpected Drive request: ${href}`);
    };

    const response = await requestAdminSync(session.sessionId, env);
    assert.equal(response.status, 502);
    assert.deepEqual(
      uploadedNames,
      [`${session.sessionId}_文字起こし.txt`],
      "the worker must stop at its next progress check instead of re-uploading every artifact",
    );
    const sync = database.externalSyncs.get(session.sessionId);
    // The losing worker's failure write is fenced on its own claim, so it must not
    // mark the archive that the new owner is now running as failed.
    assert.equal(sync.started_at, "2099-01-01T00:00:00.000Z");
    assert.notEqual(sync.status, "failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
