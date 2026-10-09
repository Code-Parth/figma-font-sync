import { createRoute, z } from "@hono/zod-openapi";
import {
  CandidatesSchema,
  ErrorSchema,
  FileIdsRequestSchema,
  HealthSchema,
  InstallResponseSchema,
  LibraryFilesSchema,
  LoginResponseSchema,
  MembersSchema,
  OkSchema,
  PairCompleteRequestSchema,
  PairCompleteResponseSchema,
  PairStartRequestSchema,
  PairStartResponseSchema,
  PublishLocalRequestSchema,
  RemoveResponseSchema,
  ResolveRequestSchema,
  ResolveResponseSchema,
  SelectLibraryRequestSchema,
  StatusSchema,
  UploadFormSchema,
  UploadResponseSchema,
} from "./schemas";

/*
 * HTTP status conventions:
 *   401 missing or invalid pairing token
 *   403 Drive denied the action for this user
 *   409 a precondition on helper state: not-configured, not-signed-in, no-library
 *   429 pairing rate limit
 *   502 Google returned an error
 */
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});
const error = (description: string) => json(ErrorSchema, description);
const body = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { "application/json": { schema } },
});
const authed = [{ Bearer: [] }];
const stateErrors = {
  401: error("Missing or invalid pairing token"),
  409: error("Helper is not configured, not signed in, or has no library selected"),
  502: error("Google API error"),
} as const;

export const healthRoute = createRoute({
  method: "get",
  path: "/health",
  operationId: "getHealth",
  tags: ["meta"],
  responses: { 200: json(HealthSchema, "Helper is running") },
});

export const pairStartRoute = createRoute({
  method: "post",
  path: "/pair/start",
  operationId: "startPairing",
  tags: ["pairing"],
  request: { body: body(PairStartRequestSchema) },
  responses: {
    200: json(PairStartResponseSchema, "Code created and shown at /pair"),
    400: error("Invalid request"),
    429: error("Too many pairing attempts"),
  },
});

export const pairCompleteRoute = createRoute({
  method: "post",
  path: "/pair/complete",
  operationId: "completePairing",
  tags: ["pairing"],
  request: { body: body(PairCompleteRequestSchema) },
  responses: {
    200: json(PairCompleteResponseSchema, "Paired; keep the token"),
    400: error("Invalid request"),
    401: error("Wrong or expired code"),
    429: error("Too many attempts"),
  },
});

export const unpairRoute = createRoute({
  method: "delete",
  path: "/pair",
  operationId: "unpair",
  tags: ["pairing"],
  security: authed,
  responses: { 200: json(OkSchema, "Token revoked"), 401: error("Missing or invalid pairing token") },
});

export const statusRoute = createRoute({
  method: "get",
  path: "/status",
  operationId: "getStatus",
  tags: ["meta"],
  security: authed,
  responses: { 200: json(StatusSchema, "Helper status"), 401: error("Missing or invalid pairing token") },
});

export const loginRoute = createRoute({
  method: "post",
  path: "/auth/login",
  operationId: "login",
  tags: ["auth"],
  security: authed,
  responses: {
    200: json(LoginResponseSchema, "Browser opened for Google sign-in; poll /status"),
    401: stateErrors[401],
    409: stateErrors[409],
  },
});

export const logoutRoute = createRoute({
  method: "post",
  path: "/auth/logout",
  operationId: "logout",
  tags: ["auth"],
  security: authed,
  responses: { 200: json(StatusSchema, "Signed out"), 401: stateErrors[401] },
});

export const candidatesRoute = createRoute({
  method: "get",
  path: "/library/candidates",
  operationId: "listLibraryCandidates",
  tags: ["library"],
  security: authed,
  responses: { 200: json(CandidatesSchema, "Folders named font-sync-figma-plugin this user can see"), ...stateErrors },
});

export const selectLibraryRoute = createRoute({
  method: "post",
  path: "/library/select",
  operationId: "selectLibrary",
  tags: ["library"],
  security: authed,
  request: { body: body(SelectLibraryRequestSchema) },
  responses: {
    200: json(StatusSchema, "Library selected"),
    400: error("Not a font-sync-figma-plugin folder"),
    404: error("Folder not found or not shared with this user"),
    ...stateErrors,
  },
});

export const createLibraryRoute = createRoute({
  method: "post",
  path: "/library/create",
  operationId: "createLibrary",
  tags: ["library"],
  security: authed,
  responses: { 200: json(StatusSchema, "Folder created in this user's My Drive and selected"), ...stateErrors },
});

export const libraryFilesRoute = createRoute({
  method: "get",
  path: "/library/files",
  operationId: "listLibraryFiles",
  tags: ["library"],
  security: authed,
  request: {
    query: z.object({
      refresh: z
        .enum(["true", "false"])
        .optional()
        .openapi({ description: "Re-list the Drive folder instead of using the last sync" }),
    }),
  },
  responses: { 200: json(LibraryFilesSchema, "Font files in the library"), ...stateErrors },
});

export const installRoute = createRoute({
  method: "post",
  path: "/library/install",
  operationId: "installFonts",
  tags: ["library"],
  security: authed,
  request: { body: body(FileIdsRequestSchema) },
  responses: { 200: json(InstallResponseSchema, "Per-file results"), ...stateErrors },
});

export const uninstallRoute = createRoute({
  method: "post",
  path: "/library/uninstall",
  operationId: "uninstallFonts",
  tags: ["library"],
  security: authed,
  request: { body: body(FileIdsRequestSchema) },
  responses: { 200: json(InstallResponseSchema, "Per-file results"), ...stateErrors },
});

export const uploadRoute = createRoute({
  method: "post",
  path: "/library/upload",
  operationId: "uploadFonts",
  tags: ["library"],
  security: authed,
  request: { body: { required: true, content: { "multipart/form-data": { schema: UploadFormSchema } } } },
  responses: {
    200: json(UploadResponseSchema, "Per-file results"),
    400: error("No files"),
    403: error("This user cannot add files to the library"),
    ...stateErrors,
  },
});

export const publishLocalRoute = createRoute({
  method: "post",
  path: "/library/publish-local",
  operationId: "publishLocalFonts",
  tags: ["library"],
  security: authed,
  request: { body: body(PublishLocalRequestSchema) },
  responses: {
    200: json(UploadResponseSchema, "Per-font results; the helper finds the files on this machine"),
    403: error("This user cannot add files to the library"),
    ...stateErrors,
  },
});

export const removeFileRoute = createRoute({
  method: "delete",
  path: "/library/files/{fileId}",
  operationId: "removeLibraryFile",
  tags: ["library"],
  security: authed,
  request: { params: z.object({ fileId: z.string().min(1) }) },
  responses: {
    200: json(RemoveResponseSchema, "Removed from the library"),
    403: error("This user cannot remove the file"),
    404: error("Not in the library"),
    ...stateErrors,
  },
});

export const membersRoute = createRoute({
  method: "get",
  path: "/library/members",
  operationId: "listLibraryMembers",
  tags: ["library"],
  security: authed,
  responses: { 200: json(MembersSchema, "People the library folder is shared with"), ...stateErrors },
});

export const resolveRoute = createRoute({
  method: "post",
  path: "/fonts/resolve",
  operationId: "resolveFonts",
  tags: ["fonts"],
  security: authed,
  request: { body: body(ResolveRequestSchema) },
  responses: { 200: json(ResolveResponseSchema, "Library match and local state per font"), ...stateErrors },
});
