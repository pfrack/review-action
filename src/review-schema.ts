import { z } from 'zod';

export const ReviewFindingSchema = z.object({
  file: z.string(),
  severity: z.enum(['Critical', 'Warning', 'Suggestion']),
  line_start: z.number().nullable().optional(),
  line_end: z.number().nullable().optional(),
  issue: z.string(),
  suggestion: z.string().nullable().optional(),
  critical_action: z.string(),
  warning_action: z.string(),
  suggestion_action: z.string(),
});

export const ReviewSchema = z.object({
  findings: z.array(ReviewFindingSchema),
  summary: z.string().nullable().optional(),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewType = z.infer<typeof ReviewSchema>;

// Hand-written JSON Schema for maximum provider compatibility.
// z.toJSONSchema() adds "$schema" draft metadata and uses "anyOf" for
// nullable fields — both of which some LLM providers reject.
// IMPORTANT: Keep in sync with ReviewFindingSchema and ReviewSchema above.
export const ReviewJsonSchema = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          severity: { type: 'string', enum: ['Critical', 'Warning', 'Suggestion'] },
          line_start: { type: ['number', 'null'] },
          line_end: { type: ['number', 'null'] },
          issue: { type: 'string' },
          suggestion: { type: ['string', 'null'] },
          critical_action: { type: 'string' },
          warning_action: { type: 'string' },
          suggestion_action: { type: 'string' },
        },
        required: ['file', 'severity', 'issue', 'critical_action', 'warning_action', 'suggestion_action'],
        additionalProperties: false,
      },
    },
    summary: { type: ['string', 'null'] },
  },
  required: ['findings'],
  additionalProperties: false,
};

export const JSON_SCHEMA_DEFINITION =
  'Respond in JSON matching this schema: ```json\n' +
  JSON.stringify(ReviewJsonSchema) +
  '\n```\n' +
  'Include a "findings" array. If the code looks fine, respond with an empty findings array.';


