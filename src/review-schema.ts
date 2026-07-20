import { z } from 'zod';

export const ReviewFindingSchema = z.object({
  file: z.string(),
  severity: z.enum(['Critical', 'Warning', 'Suggestion']),
  line_start: z.number().nullable().optional(),
  line_end: z.number().nullable().optional(),
  issue: z.string(),
  suggestion: z.string().nullable().optional(),
});

export const ReviewSchema = z.object({
  findings: z.array(ReviewFindingSchema),
  summary: z.string().nullable().optional(),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewType = z.infer<typeof ReviewSchema>;

export const ReviewJsonSchema = z.toJSONSchema(ReviewSchema);

export const JSON_SCHEMA_DEFINITION =
  'Respond in JSON matching this schema: ```json\n' +
  JSON.stringify(ReviewJsonSchema) +
  '\n```\n' +
  'Include a "findings" array. If the code looks fine, respond with an empty findings array.';

export const codeReviewSchemaDef = JSON_SCHEMA_DEFINITION;
