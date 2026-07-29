import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const interviewSessions = sqliteTable("interview_sessions", {
  id: text("id").primaryKey(),
  accessTokenHash: text("access_token_hash").notNull(),
  employment: text("employment").notNull(),
  preferredLocation: text("preferred_location").notNull(),
  consentVersion: text("consent_version").notNull(),
  consentedAt: text("consented_at").notNull(),
  status: text("status").notNull().default("created"),
  recordingStatus: text("recording_status").notNull().default("not_started"),
  transcriptJson: text("transcript_json"),
  evaluationJson: text("evaluation_json"),
  summary: text("summary"),
  expiresAt: text("expires_at").notNull(),
  retentionUntil: text("retention_until").notNull(),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("interview_sessions_status_idx").on(table.status),
  index("interview_sessions_retention_idx").on(table.retentionUntil),
]);

export const interviewArtifacts = sqliteTable("interview_artifacts", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => interviewSessions.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  objectKey: text("object_key").notNull().unique(),
  contentType: text("content_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  etag: text("etag"),
  retentionUntil: text("retention_until").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("interview_artifacts_session_idx").on(table.sessionId),
  index("interview_artifacts_retention_idx").on(table.retentionUntil),
]);

export const interviewAuditEvents = sqliteTable("interview_audit_events", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => interviewSessions.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  actorType: text("actor_type").notNull(),
  detailJson: text("detail_json"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("interview_audit_events_session_idx").on(table.sessionId),
]);

export const interviewHumanReviews = sqliteTable("interview_human_reviews", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => interviewSessions.id, { onDelete: "cascade" }),
  reviewerName: text("reviewer_name").notNull(),
  videoScoresJson: text("video_scores_json").notNull(),
  overallNote: text("overall_note"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("interview_human_reviews_session_idx").on(table.sessionId),
  uniqueIndex("interview_human_reviews_session_reviewer_unique").on(table.sessionId, table.reviewerName),
]);
