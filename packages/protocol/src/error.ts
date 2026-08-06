import Type from "typebox";

export const ApiErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    requestId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type ApiError = Type.Static<typeof ApiErrorSchema>;
