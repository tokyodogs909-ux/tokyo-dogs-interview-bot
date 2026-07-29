import { noStoreJson, requireOpenAIApiKey } from "@/lib/openai-server";

export async function GET() {
  try {
    requireOpenAIApiKey();
    return noStoreJson({ configured: true });
  } catch {
    return noStoreJson({ configured: false }, { status: 503 });
  }
}

