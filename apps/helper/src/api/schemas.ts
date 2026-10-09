import { z } from "@hono/zod-openapi";
import { ERROR_CODES } from "../errors";
import type { Face } from "../fonts/types";

export const FontKeySchema = z
  .object({ family: z.string().min(1).max(256), style: z.string().min(1).max(256) })
  .openapi("FontKey");

export const FaceSchema = z
  .object({
    family: z.string(),
    style: z.string(),
    postscript: z.string().nullable(),
    fullName: z.string().nullable(),
    legacyFamily: z.string().nullable(),
    legacyStyle: z.string().nullable(),
    weight: z.number(),
    italic: z.boolean(),
    variable: z.boolean(),
  })
  .openapi("Face");

// Compile-time guard: the API shape and the domain type must not drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const faceShapeMatches: Same<z.infer<typeof FaceSchema>, Face> = true;
void faceShapeMatches;

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ErrorSchema = z
  .object({ error: z.object({ code: ErrorCodeSchema, message: z.string() }) })
  .openapi("Error");

export const HealthSchema = z
  .object({ ok: z.literal(true), name: z.literal("font-sync"), version: z.string() })
  .openapi("Health");

export const RoleSchema = z.enum(["owner", "editor", "viewer"]).openapi("Role");

export const LibrarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    webViewLink: z.string(),
    owner: z.string().nullable().openapi({ description: "Owner email or display name" }),
    role: RoleSchema,
    canUpload: z.boolean(),
  })
  .openapi("Library");

export const AuthStateSchema = z.enum(["not-configured", "signed-out", "signing-in", "signed-in", "expired"]).openapi("AuthState");

export const StatusSchema = z
  .object({
    version: z.string(),
    platform: z.enum(["darwin", "win32", "linux"]),
    auth: AuthStateSchema,
    account: z.object({ email: z.string(), name: z.string().nullable() }).nullable(),
    library: LibrarySchema.nullable(),
    /** Why the selected library could not be read (Drive error), or null. A deleted or trashed folder is library null with no error. */
    libraryError: z.string().nullable(),
  })
  .openapi("Status");

export const PairStartRequestSchema = z.object({ clientName: z.string().min(1).max(100) }).openapi("PairStartRequest");
export const PairStartResponseSchema = z
  .object({ expiresAt: z.string().openapi({ format: "date-time" }) })
  .openapi("PairStartResponse");
export const PairCompleteRequestSchema = z
  .object({ code: z.string().regex(/^\d{6}$/), clientName: z.string().min(1).max(100) })
  .openapi("PairCompleteRequest");
export const PairCompleteResponseSchema = z.object({ token: z.string() }).openapi("PairCompleteResponse");

export const LoginResponseSchema = z.object({ url: z.string() }).openapi("LoginResponse");

export const FolderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    owner: z.string().nullable(),
    webViewLink: z.string(),
    modifiedTime: z.string(),
  })
  .openapi("Folder");
export const CandidatesSchema = z
  .object({
    folders: z.array(FolderSchema),
    /** Google returned a partial search, so a folder shared with this user may be missing. */
    incomplete: z.boolean(),
  })
  .openapi("Candidates");
export const SelectLibraryRequestSchema = z.object({ folderId: z.string().min(1) }).openapi("SelectLibraryRequest");

/** "not-in-library": Font Sync installed it on this machine, but the file has left the library. */
export const InstallStateSchema = z.enum(["not-installed", "installed", "outdated", "not-in-library"]).openapi("InstallState");

export const LibraryFileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** Folder path inside the library, "" for the root. */
    path: z.string(),
    size: z.number(),
    md5: z.string(),
    modifiedTime: z.string(),
    uploadedBy: z.string().nullable(),
    faces: z.array(FaceSchema),
    parseError: z.string().nullable(),
    install: InstallStateSchema,
    canRemove: z.boolean(),
  })
  .openapi("LibraryFile");
export const LibraryFilesSchema = z
  .object({ files: z.array(LibraryFileSchema), syncedAt: z.string().openapi({ format: "date-time" }) })
  .openapi("LibraryFiles");

export const ResolveRequestSchema = z.object({ fonts: z.array(FontKeySchema).max(5000) }).openapi("ResolveRequest");
export const ResolvedFontSchema = z
  .object({
    family: z.string(),
    style: z.string(),
    library: z
      .object({ fileId: z.string(), face: FaceSchema, tier: z.enum(["exact", "normalized", "alias"]) })
      .nullable(),
    local: z.object({
      /** A file on this machine provides exactly this {family, style} (any source, not only Font Sync). */
      onDisk: z.boolean(),
      /** Font Sync installed the matching library file on this machine. */
      installedBySync: z.boolean(),
      /** A local, non-system file could be uploaded to the library. */
      uploadable: z.boolean(),
    }),
  })
  .openapi("ResolvedFont");
export const ResolveResponseSchema = z.object({ fonts: z.array(ResolvedFontSchema) }).openapi("ResolveResponse");

export const FileIdsRequestSchema = z.object({ fileIds: z.array(z.string().min(1)).min(1).max(500) }).openapi("FileIdsRequest");
export const FileResultSchema = z
  .object({ fileId: z.string(), ok: z.boolean(), error: z.string().nullable() })
  .openapi("FileResult");
export const InstallResponseSchema = z
  .object({
    results: z.array(FileResultSchema),
    /** True when Figma has to reload the file tab before it can see the change. */
    reloadRequired: z.boolean(),
  })
  .openapi("InstallResponse");

export const UploadResultSchema = z
  .object({
    name: z.string(),
    ok: z.boolean(),
    fileId: z.string().nullable(),
    duplicateOf: z.string().nullable(),
    error: z.string().nullable(),
    faces: z.array(FaceSchema),
  })
  .openapi("UploadResult");
export const UploadResponseSchema = z.object({ results: z.array(UploadResultSchema) }).openapi("UploadResponse");
export const UploadFormSchema = z
  .object({
    files: z
      .union([z.instanceof(File), z.array(z.instanceof(File))])
      .openapi({ type: "array", items: { type: "string", format: "binary" } }),
  })
  .openapi("UploadForm");

export const PublishLocalRequestSchema = z.object({ fonts: z.array(FontKeySchema).min(1).max(200) }).openapi("PublishLocalRequest");

export const RemoveResponseSchema = z.object({ removed: z.enum(["trashed", "unlinked"]) }).openapi("RemoveResponse");

export const MemberSchema = z
  .object({
    email: z.string().nullable(),
    name: z.string().nullable(),
    role: z.enum(["owner", "organizer", "fileOrganizer", "writer", "commenter", "reader"]),
    type: z.enum(["user", "group", "domain", "anyone"]),
  })
  .openapi("Member");
export const MembersSchema = z.object({ members: z.array(MemberSchema) }).openapi("Members");

export const OkSchema = z.object({ ok: z.literal(true) }).openapi("Ok");
