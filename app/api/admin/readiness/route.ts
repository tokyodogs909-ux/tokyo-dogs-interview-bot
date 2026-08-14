import { adminAuthenticationReadiness, authorizeInterviewAdminOrSetupSession } from "@/lib/admin-auth";
import {
  missingGoogleDriveConfiguration,
  validateGoogleDriveRoot,
} from "@/lib/google-drive-auth";
import { missingGoogleDriveOAuthSetupConfiguration } from "@/lib/google-drive-connection";
import { inviteSigningReadiness, signedInvitesRequired } from "@/lib/interview-invite";
import { backgroundRecoveryAuthenticationReadiness } from "@/lib/interview-background-recovery";
import {
  hasInterviewDatabase,
  hasRecordingStorage,
  reviewerAuthenticationReadiness,
} from "@/lib/interview-persistence";
import { noStoreJson, verifyOpenAIAuthentication } from "@/lib/openai-server";

export async function GET(request: Request) {
  try {
    if (!await authorizeInterviewAdminOrSetupSession(request)) {
      return noStoreJson({ error: "管理者認証を確認できません。" }, { status: 401 });
    }

    const reviewerAuth = reviewerAuthenticationReadiness();
    const secretStrength = {
      admin: adminAuthenticationReadiness(),
      staff: reviewerAuth,
      invite: inviteSigningReadiness(),
      recovery: backgroundRecoveryAuthenticationReadiness(),
    };
    const database = hasInterviewDatabase();
    const recordingStorage = hasRecordingStorage();
    const driveMissing = await missingGoogleDriveConfiguration();
    const driveOAuthMissing = missingGoogleDriveOAuthSetupConfiguration();
    const [openAIAuthenticated, driveRoot] = await Promise.all([
      verifyOpenAIAuthentication().catch(() => false),
      driveMissing.length === 0
        ? validateGoogleDriveRoot()
          .then((root) => ({
            authenticated: true as const,
            name: root.name,
            locationType: root.locationType,
          }))
          .catch(() => ({ authenticated: false as const }))
        : Promise.resolve({ authenticated: false as const }),
    ]);
    const missing = [
      ...(!openAIAuthenticated ? ["OPENAI_AUTHENTICATION"] : []),
      ...(!database ? ["INTERVIEW_DATABASE"] : []),
      ...(!recordingStorage ? ["RECORDING_STORAGE"] : []),
      ...(!reviewerAuth.configured ? ["INTERVIEW_STAFF_AUTHENTICATION"] : []),
      ...driveMissing,
      ...driveOAuthMissing,
      ...(driveMissing.length === 0 && !driveRoot.authenticated ? ["GOOGLE_DRIVE_AUTHENTICATION"] : []),
    ].filter((name, index, values) => values.indexOf(name) === index);
    const technicallyReady = missing.length === 0;

    return noStoreJson({
      technicallyReady,
      openAIAuthenticated,
      database,
      recordingStorage,
      reviewerAuth,
      secretStrength,
      warnings: Object.entries(secretStrength)
        .filter(([, value]) => value.configured && !value.strong)
        .map(([name]) => `WEAK_${name.toUpperCase()}_SECRET`),
      driveOAuthSetup: { configured: driveOAuthMissing.length === 0 },
      drive: driveRoot,
      candidateEntryMode: signedInvitesRequired() ? "signed_invite" : "common_url",
      missing,
    }, { status: technicallyReady ? 200 : 503 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return noStoreJson({
      error: code === "INTERVIEW_ADMIN_AUTH_UNCONFIGURED"
        ? "管理者用認証の設定が完了していません。"
        : "本番稼働条件を確認できませんでした。",
    }, { status: code === "INTERVIEW_ADMIN_AUTH_UNCONFIGURED" ? 503 : 500 });
  }
}
