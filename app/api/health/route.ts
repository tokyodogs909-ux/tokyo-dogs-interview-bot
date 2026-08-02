import { noStoreJson, verifyOpenAIAuthentication } from "@/lib/openai-server";

export async function GET() {
  try {
    if (await verifyOpenAIAuthentication()) return noStoreJson({ configured: true });
    return noStoreJson({ configured: false }, { status: 503 });
  } catch {
    return noStoreJson({ configured: false }, { status: 503 });
  }
}
