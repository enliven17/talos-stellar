import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { getLLMClient, getLLMModel, resetLLMClients, analyzeWithGPT } from '../src/lib/fulfillment/clients';
import OpenAI from 'openai';

vi.mock('openai', () => {
  const MockOpenAI = vi.fn().mockImplementation(function (this: any, config?: { apiKey?: string; baseURL?: string }) {
    this.apiKey = config?.apiKey;
    this.baseURL = config?.baseURL;
    this.chat = {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: '{"status":"ok"}' } }],
        }),
      },
    };
  });
  return { default: MockOpenAI };
});

describe('fulfillment clients and model configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.FULFILLMENT_LLM_MODEL;
    resetLLMClients();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetLLMClients();
  });

  describe('getLLMModel', () => {
    it('returns default model for Groq when GROQ_API_KEY is set and no override is present', () => {
      process.env.GROQ_API_KEY = 'gsk-test-key';

      expect(getLLMModel()).toBe('llama-3.3-70b-versatile');
    });

    it('returns default model for OpenAI when OPENAI_API_KEY is set and no override is present', () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';

      expect(getLLMModel()).toBe('gpt-4o');
    });

    it('honours FULFILLMENT_LLM_MODEL override when using Groq', () => {
      process.env.GROQ_API_KEY = 'gsk-test-key';
      process.env.FULFILLMENT_LLM_MODEL = 'llama-3.1-8b-instant';

      expect(getLLMModel()).toBe('llama-3.1-8b-instant');
    });

    it('honours FULFILLMENT_LLM_MODEL override when using OpenAI', () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      process.env.FULFILLMENT_LLM_MODEL = 'gpt-4o-mini';

      expect(getLLMModel()).toBe('gpt-4o-mini');
    });

    it('falls back to default model if FULFILLMENT_LLM_MODEL is empty or whitespace', () => {
      process.env.GROQ_API_KEY = 'gsk-test-key';
      process.env.FULFILLMENT_LLM_MODEL = '   ';

      expect(getLLMModel()).toBe('llama-3.3-70b-versatile');

      delete process.env.GROQ_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-test-key';
      process.env.FULFILLMENT_LLM_MODEL = '';

      expect(getLLMModel()).toBe('gpt-4o');
    });
  });

  describe('getLLMClient memoisation', () => {
    it('memoises Groq client across multiple calls', () => {
      process.env.GROQ_API_KEY = 'gsk-test-key';

      const client1 = getLLMClient();
      const client2 = getLLMClient();

      expect(client1).toBe(client2);
      expect(OpenAI).toHaveBeenCalledTimes(1);
      expect(OpenAI).toHaveBeenCalledWith({
        apiKey: 'gsk-test-key',
        baseURL: 'https://api.groq.com/openai/v1',
      });
    });

    it('memoises OpenAI client across multiple calls', () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';

      const client1 = getLLMClient();
      const client2 = getLLMClient();

      expect(client1).toBe(client2);
      expect(OpenAI).toHaveBeenCalledTimes(1);
      expect(OpenAI).toHaveBeenCalledWith({
        apiKey: 'sk-test-key',
      });
    });

    it('memoises client per provider independently', () => {
      // First Groq
      process.env.GROQ_API_KEY = 'gsk-test-key';
      const groqClient1 = getLLMClient();

      // Switch to OpenAI (Groq unset)
      delete process.env.GROQ_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-test-key';
      const openaiClient1 = getLLMClient();

      expect(groqClient1).not.toBe(openaiClient1);
      expect(OpenAI).toHaveBeenCalledTimes(2);

      // Call OpenAI again -> returns cached OpenAI client
      const openaiClient2 = getLLMClient();
      expect(openaiClient2).toBe(openaiClient1);
      expect(OpenAI).toHaveBeenCalledTimes(2);

      // Switch back to Groq -> returns cached Groq client
      process.env.GROQ_API_KEY = 'gsk-test-key';
      const groqClient2 = getLLMClient();
      expect(groqClient2).toBe(groqClient1);
      expect(OpenAI).toHaveBeenCalledTimes(2);
    });

    it('re-instantiates client if the API key changes', () => {
      process.env.OPENAI_API_KEY = 'sk-initial-key';
      const client1 = getLLMClient();

      process.env.OPENAI_API_KEY = 'sk-updated-key';
      const client2 = getLLMClient();

      expect(client1).not.toBe(client2);
      expect(OpenAI).toHaveBeenCalledTimes(2);
    });

    it('throws when neither GROQ_API_KEY nor OPENAI_API_KEY is set', () => {
      expect(() => getLLMClient()).toThrow('Neither GROQ_API_KEY nor OPENAI_API_KEY is set');
    });

    it('resets cached clients when resetLLMClients is invoked', () => {
      process.env.GROQ_API_KEY = 'gsk-test-key';
      const client1 = getLLMClient();
      resetLLMClients();
      const client2 = getLLMClient();

      expect(client1).not.toBe(client2);
      expect(OpenAI).toHaveBeenCalledTimes(2);
    });
  });

  describe('analyzeWithGPT', () => {
    it('uses configured model when FULFILLMENT_LLM_MODEL is provided', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      process.env.FULFILLMENT_LLM_MODEL = 'custom-test-model';

      const result = await analyzeWithGPT('system instructions', 'user question');
      const client = getLLMClient();

      expect(client.chat.completions.create).toHaveBeenCalledWith({
        model: 'custom-test-model',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'system instructions' },
          { role: 'user', content: 'user question' },
        ],
      });
      expect(result).toBe('{"status":"ok"}');
    });

    it('uses default model when FULFILLMENT_LLM_MODEL is not provided', async () => {
      process.env.GROQ_API_KEY = 'gsk-test-key';

      await analyzeWithGPT('system instructions', 'user question');
      const client = getLLMClient();

      expect(client.chat.completions.create).toHaveBeenCalledWith({
        model: 'llama-3.3-70b-versatile',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'system instructions' },
          { role: 'user', content: 'user question' },
        ],
      });
    });
  });
});
