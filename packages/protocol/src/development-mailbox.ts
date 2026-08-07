import Type from "typebox";

export const DevelopmentMailboxMessageSchema = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    purpose: Type.Union([
      Type.Literal("invitation"),
      Type.Literal("verification"),
      Type.Literal("password-reset"),
    ]),
    to: Type.String({ format: "email" }),
    subject: Type.String({ minLength: 1 }),
    text: Type.String({ minLength: 1 }),
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export type DevelopmentMailboxMessage = Type.Static<typeof DevelopmentMailboxMessageSchema>;

export const DevelopmentMailboxResponseSchema = Type.Object(
  {
    messages: Type.Array(DevelopmentMailboxMessageSchema, { maxItems: 100 }),
  },
  { additionalProperties: false },
);

export type DevelopmentMailboxResponse = Type.Static<typeof DevelopmentMailboxResponseSchema>;
