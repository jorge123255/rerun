import { z } from 'zod'
import { discoveredModelSchema } from './connection.js'

// What compaction budgets against when neither the endpoint nor its owner said how large a model's
// window is. Without one, compaction has no threshold and a session grows until the server refuses it.
export const CUSTOM_DEFAULT_CONTEXT_WINDOW = 128_000

// The servers people run most, so the form only asks for what the preset cannot know. `local` ones
// listen on the owner's machine: a cloud box cannot reach them, so only a self-hosted build offers them.
export const CUSTOM_PRESETS = [
    { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', keyRequired: false, local: true },
    { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', keyRequired: false, local: true },
    { id: 'vllm', label: 'vLLM', baseUrl: 'http://localhost:8000/v1', keyRequired: false, local: true },
    { id: 'litellm', label: 'LiteLLM', baseUrl: 'http://localhost:4000/v1', keyRequired: true, local: true },
    { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyRequired: true, local: false },
    { id: 'together', label: 'Together', baseUrl: 'https://api.together.xyz/v1', keyRequired: true, local: false },
    { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyRequired: true, local: false },
    { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyRequired: true, local: false },
] as const
export type CustomPreset = (typeof CUSTOM_PRESETS)[number]

// `model` is for a server that does not list its models: the probe then asks it for one token of
// that model instead.
export const customProbeInputSchema = z.object({
    baseUrl: z.url(),
    apiKey: z.string().trim().optional(),
    model: z.string().trim().min(1).optional(),
})
export type CustomProbeInput = z.infer<typeof customProbeInputSchema>

// `baseUrl` is the address that answered, which is not always the one typed: `localhost` seen from
// an engine in a container is the container itself, so the probe also tries the Docker host.
export const customProbeProblemSchema = z.enum(['unreachable', 'unauthorized', 'not_listed', 'model_refused'])
export type CustomProbeProblem = z.infer<typeof customProbeProblemSchema>

export const customProbeResultSchema = z.object({
    baseUrl: z.string(),
    models: z.array(discoveredModelSchema),
    problem: customProbeProblemSchema.nullable(),
    detail: z.string().nullable(),
})
export type CustomProbeResult = z.infer<typeof customProbeResultSchema>
