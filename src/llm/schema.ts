import { z } from "zod";

export const opportunityTypeEnum = z.enum([
  "HOT_LEAD",
  "WARM_LEAD",
  "DISCUSSION",
  "EXPERTISE",
  "NETWORKING",
  "FUTURE",
  "INFORMATION",
  "NOISE",
]);

export const analysisSchema = z.object({
  relevance: z.number().int().min(0).max(100),
  purchase_intent: z.number().int().min(0).max(100),
  engagement_opportunity: z.number().int().min(0).max(100),
  future_potential: z.number().int().min(0).max(100),
  urgency: z.number().int().min(0).max(100),
  client_probability: z.number().int().min(0).max(100),
  type: opportunityTypeEnum,
  signal_track: z.enum(["client", "expertise"]).nullable(),
  relatedness: z.enum(["direct", "adjacent", "contextual"]).nullable(),
  stage: z.string().nullable(),
  trajectory: z.string().nullable(),
  topic: z.string(),
  summary: z.string(),
  reasoning: z.array(z.string()).max(6),
  talking_points: z.array(z.string()).max(5),
  avoid: z.array(z.string()).max(5),
  recommended_action: z.string(),
  suggested_message: z.string().nullable(),
});

export type AnalysisResult = z.infer<typeof analysisSchema>;
