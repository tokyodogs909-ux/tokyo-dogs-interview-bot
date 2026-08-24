import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("a running Drive claim preserves its original request fence", async () => {
  const source = await readFile(new URL("../lib/interview-persistence.ts", import.meta.url), "utf8");
  assert.match(source, /requested_at = CASE WHEN interview_external_syncs\.status = 'running'[\s\S]*?THEN interview_external_syncs\.requested_at ELSE excluded\.requested_at END/);
});

test("a prior finalized manifest is adopted before a redundant recording upload", async () => {
  const source = await readFile(new URL("../lib/google-drive-sync.ts", import.meta.url), "utf8");
  const helper = source.indexOf("async function finalizedRecordingFromDriveManifest");
  const resumeBranch = source.indexOf("const finalizedRecording = await finalizedRecordingFromDriveManifest", source.indexOf("if (step.phase === \"finalizing\")"));
  const resumableStatus = source.indexOf("let uploadLocation = await decryptGoogleDriveUploadCapability", resumeBranch);
  assert.ok(helper >= 0, "the Drive-side completion receipt validator must exist");
  assert.ok(resumeBranch > helper, "an interrupted upload must check for an existing finalized receipt");
  assert.ok(resumableStatus > resumeBranch, "the receipt must be adopted before querying or sending another recording range");
  assert.match(source.slice(helper, resumeBranch), /receipt\.sessionId !== input\.source\.sessionId/);
  assert.match(source.slice(helper, resumeBranch), /recorded\?\.id !== recordingId/);
  assert.match(source.slice(helper, resumeBranch), /Number\(recorded\?\.size\) !== input\.source\.recording\.byteSize/);
});
