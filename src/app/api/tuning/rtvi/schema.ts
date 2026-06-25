import { z } from "zod";

export const RtviTuningSchema = z.object({
  maxNumSeqs: z.number().int().positive().optional(),
  kvCachePercent: z.number().min(0).max(1).optional(),
  maxModelLen: z.number().int().positive().optional(),
  modelProfile: z.string().optional(),
  disableCudaGraph: z.boolean().optional(),
  numSchedulerSteps: z.number().int().min(1).max(32).optional(),
  maxNumBatchedTokens: z.number().int().min(1024).max(32768).optional(),
  maxGenerationTokens: z.number().int().min(64).max(16384).optional(),
}).refine(
  (d) => Object.values(d).some((v) => v !== undefined),
  { message: "At least one tuning field is required" }
);

export type RtviTuning = z.infer<typeof RtviTuningSchema>;
