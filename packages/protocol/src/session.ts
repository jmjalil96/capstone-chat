import Type from "typebox";

const EmployeeSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    email: Type.String({ format: "email" }),
  },
  { additionalProperties: false },
);

const WorkspaceSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    identity: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    role: Type.Union([Type.Literal("admin"), Type.Literal("member")]),
  },
  { additionalProperties: false },
);

const SessionTimingSchema = Type.Object(
  {
    createdAt: Type.String({ format: "date-time" }),
    expiresAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export const SessionResponseSchema = Type.Object(
  {
    employee: EmployeeSchema,
    workspace: WorkspaceSchema,
    session: SessionTimingSchema,
  },
  { additionalProperties: false },
);

export type SessionResponse = Type.Static<typeof SessionResponseSchema>;
