// Keep the readiness check under the Google Drive setup cookie path as well as
// the general admin path. This lets an OAuth setup started before the broader
// cookie path was introduced finish without asking the administrator to paste
// the access key again.
export { GET } from "@/app/api/admin/readiness/route";
