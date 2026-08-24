import { stepInterviewToGoogleDrive } from "@/lib/google-drive-sync";
import { readBoundedJsonBody } from "@/lib/http-body";
import { noStoreJson } from "@/lib/openai-server";
import { authorizeBearerSecret, serverSecretReadiness } from "@/lib/server-secret-auth";

type IncidentRepairBindings = {
  INTERVIEW_INCIDENT_REPAIR_TOKEN?: string;
  INTERVIEW_INCIDENT_REPAIR_SESSION_ID?: string;
};

function incidentRepairBindings() {
  return (globalThis as typeof globalThis & {
    __TOKYO_DOGS_INTERVIEW_BINDINGS__?: IncidentRepairBindings;
  }).__TOKYO_DOGS_INTERVIEW_BINDINGS__ ?? {};
}

function configuredValue(key: keyof IncidentRepairBindings) {
  return (
    incidentRepairBindings()[key] ??
    (typeof process === "undefined" ? "" : process.env[key]) ??
    ""
  ).trim();
}

export async function POST(request: Request) {
  try {
    const token = configuredValue("INTERVIEW_INCIDENT_REPAIR_TOKEN");
    const sessionId = configuredValue("INTERVIEW_INCIDENT_REPAIR_SESSION_ID");
    if (!serverSecretReadiness(token).strong || !/^TD-[A-Z0-9]{8}-[A-Z0-9]{7}$/.test(sessionId)) {
      return noStoreJson({ error: "Incident repair is not configured." }, { status: 503 });
    }
    if (!await authorizeBearerSecret(request, token)) {
      return noStoreJson({ error: "Incident repair authentication failed." }, { status: 401 });
    }
    const body = await readBoundedJsonBody(request, { maxBytes: 64 });
    if (!body.ok) return noStoreJson({ error: "Incident repair request is invalid." }, { status: body.status });
    if (
      !body.value || typeof body.value !== "object" || Array.isArray(body.value) ||
      Object.keys(body.value).length !== 0
    ) return noStoreJson({ error: "Incident repair request is invalid." }, { status: 400 });

    const result = await stepInterviewToGoogleDrive(sessionId);
    if ("phase" in result) {
      return noStoreJson({ state: result.status, phase: result.phase, integrity: null });
    }
    return noStoreJson({
      state: result.status,
      phase: result.status === "completed" ? "complete" : "retrying",
      integrity: result.integrity?.status ?? null,
    });
  } catch {
    console.error("interview_incident_repair_failed");
    return noStoreJson({ error: "Incident repair failed." }, { status: 500 });
  }
}
