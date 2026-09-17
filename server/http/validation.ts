import type { z } from "zod";
import { AppError } from "./errors";

export function parseInput<TSchema extends z.ZodType>(schema: TSchema, input: unknown): z.infer<TSchema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      "The request contains invalid data.",
      422,
      result.error.flatten(),
    );
  }
  return result.data;
}
