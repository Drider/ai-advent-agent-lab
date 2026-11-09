const configuredDefaultModel = process.env.LLM_MODEL_DEFAULT?.trim()

export default defineNuxtConfig({
  srcDir: '.',
  modules: ['@nuxt/ui', '@comark/nuxt'],
  css: ['~/app/assets/css/main.css'],
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  runtimeConfig: {
    llmApiKey: process.env.LLM_API_KEY ?? '',
    llmBaseUrl: process.env.LLM_BASE_URL ?? '',
    llmLogLevel: process.env.LLM_LOG_LEVEL ?? 'basic',
    public: {
      chatDefaultModel: configuredDefaultModel || 'deepseek/deepseek-v4.1-flash',
    },
  },
  typescript: {
    strict: true,
    typeCheck: true,
  },
})
