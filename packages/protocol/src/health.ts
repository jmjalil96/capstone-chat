import Type from "typebox";

export const LivenessResponseSchema = Type.Object(
  {
    status: Type.Literal("live"),
  },
  { additionalProperties: false },
);

export type LivenessResponse = Type.Static<typeof LivenessResponseSchema>;

export const DatabaseStatusSchema = Type.Union([
  Type.Literal("up"),
  Type.Literal("down"),
  Type.Literal("unknown"),
]);

export type DatabaseStatus = Type.Static<typeof DatabaseStatusSchema>;

export const ReadinessResponseSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal("ready"),
      database: Type.Literal("up"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal("unavailable"),
      database: Type.Union([Type.Literal("down"), Type.Literal("unknown")]),
    },
    { additionalProperties: false },
  ),
]);

export type ReadinessResponse = Type.Static<typeof ReadinessResponseSchema>;
