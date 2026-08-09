import Type from "typebox";

export const CLIENT_ERROR_REPORT_MAX_ASSET_LENGTH = 128;
export const CLIENT_ERROR_REPORT_MAX_POSITION = 1_000_000;
export const CLIENT_ERROR_REPORT_MAX_RELEASE_LENGTH = 128;

export const ClientErrorKindSchema = Type.Union([
  Type.Literal("render"),
  Type.Literal("resource"),
  Type.Literal("unhandled_error"),
  Type.Literal("unhandled_rejection"),
]);

export type ClientErrorKind = Type.Static<typeof ClientErrorKindSchema>;

export const ClientErrorRouteSchema = Type.Union([
  Type.Literal("identity"),
  Type.Literal("chat"),
  Type.Literal("admin"),
  Type.Literal("unknown"),
]);

export type ClientErrorRoute = Type.Static<typeof ClientErrorRouteSchema>;

export const ClientErrorReportSchema = Type.Object(
  {
    kind: ClientErrorKindSchema,
    route: ClientErrorRouteSchema,
    release: Type.String({
      maxLength: CLIENT_ERROR_REPORT_MAX_RELEASE_LENGTH,
      minLength: 1,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
    }),
    asset: Type.Optional(
      Type.String({
        maxLength: CLIENT_ERROR_REPORT_MAX_ASSET_LENGTH,
        minLength: 1,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9_-]{6,}\\.(?:css|js)$",
      }),
    ),
    line: Type.Optional(Type.Integer({ maximum: CLIENT_ERROR_REPORT_MAX_POSITION, minimum: 0 })),
    column: Type.Optional(Type.Integer({ maximum: CLIENT_ERROR_REPORT_MAX_POSITION, minimum: 0 })),
  },
  { additionalProperties: false },
);

export type ClientErrorReport = Type.Static<typeof ClientErrorReportSchema>;
