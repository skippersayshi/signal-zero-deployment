import * as fs from 'fs/promises';
import * as path from 'path';

type SwarmApiConfig = {
    provider: string;
    model: string;
    baseUrl?: string;
    apiKey?: string;
};

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function trimTrailingSlash(value: string): string {
    return value.replace(/\/+$/, '');
}

function getProviderKey(config: SwarmApiConfig): string {
    if (config.apiKey) return config.apiKey;

    const provider = config.provider.toLowerCase();
    if (provider === 'openai') return process.env.OPENAI_API_KEY || '';
    if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY || '';
    if (provider === 'google') return process.env.GOOGLE_API_KEY || '';
    if (provider === 'openrouter') return process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY_PRIMARY || '';
    if (provider === 'mistral') return process.env.MISTRAL_API_KEY || '';
    if (provider === 'groq') return process.env.GROQ_API_KEY || '';
    if (provider === 'deepseek') return process.env.DEEPSEEK_API_KEY || '';
    return process.env.SWARM_API_KEY || '';
}

async function callOpenAiCompatible(prompt: string, context: string, config: SwarmApiConfig, apiKey: string): Promise<string> {
    const baseUrl = trimTrailingSlash(config.baseUrl || 'https://api.openai.com/v1');
    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: config.model,
            temperature: 0.2,
            messages: [
                {
                    role: 'system',
                    content: 'You are Signal-Zero. Generate concise, production-minded TypeScript output for the requested task.'
                },
                {
                    role: 'user',
                    content: `Context:\n${context}\n\nTask:\n${prompt}`
                }
            ]
        })
    });

    if (!response.ok) {
        const details = await response.text();
        throw new Error(`Provider returned ${response.status}: ${details.slice(0, 500)}`);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content || '';
}

async function callAnthropic(prompt: string, context: string, config: SwarmApiConfig, apiKey: string): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: config.model,
            max_tokens: 2000,
            messages: [
                {
                    role: 'user',
                    content: `Context:\n${context}\n\nTask:\n${prompt}`
                }
            ]
        })
    });

    if (!response.ok) {
        const details = await response.text();
        throw new Error(`Anthropic returned ${response.status}: ${details.slice(0, 500)}`);
    }

    const data = await response.json() as { content?: Array<{ text?: string }> };
    return data.content?.map((part) => part.text || '').join('\n').trim() || '';
}

async function callGoogle(prompt: string, context: string, config: SwarmApiConfig, apiKey: string): Promise<string> {
    const baseUrl = trimTrailingSlash(config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
    const response = await fetch(`${baseUrl}/models/${config.model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [
                {
                    parts: [
                        { text: `Context:\n${context}\n\nTask:\n${prompt}` }
                    ]
                }
            ]
        })
    });

    if (!response.ok) {
        const details = await response.text();
        throw new Error(`Google returned ${response.status}: ${details.slice(0, 500)}`);
    }

    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n').trim() || '';
}

async function generateWithProvider(prompt: string, context: string, config: SwarmApiConfig): Promise<string | null> {
    const apiKey = getProviderKey(config);
    if (!apiKey) {
        console.log('[Signal-Zero] No API key available; writing local fallback output.');
        return null;
    }

    try {
        const provider = config.provider.toLowerCase();
        if (provider === 'anthropic') {
            return await callAnthropic(prompt, context, config, apiKey);
        }
        if (provider === 'google') {
            return await callGoogle(prompt, context, config, apiKey);
        }
        return await callOpenAiCompatible(prompt, context, config, apiKey);
    } catch (error) {
        console.error('[Signal-Zero] Provider call failed:', getErrorMessage(error));
        return null;
    }
}

function createFallback(prompt: string, context: string, config: SwarmApiConfig): string {
    return [
        `Signal-Zero local fallback for ${config.provider}/${config.model}.`,
        '',
        'The external provider did not return generated content, so this file captures the requested work packet.',
        '',
        'Prompt:',
        prompt,
        '',
        'Context excerpt:',
        context.slice(0, 4000)
    ].join('\n');
}

export async function executeTestSwarm(
    prompt: string,
    outputPath: string,
    contextPath: string,
    apiConfig: SwarmApiConfig
): Promise<void> {
    console.log(`[Signal-Zero] Starting swarm for ${apiConfig.provider}/${apiConfig.model}`);

    const context = await fs.readFile(contextPath, 'utf-8').catch(() => '');
    const generated = await generateWithProvider(prompt, context, apiConfig);
    const content = generated || createFallback(prompt, context, apiConfig);

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(
        outputPath,
        [
            '// Generated by Signal-Zero.',
            `export const generatedAt = ${JSON.stringify(new Date().toISOString())};`,
            `export const provider = ${JSON.stringify(apiConfig.provider)};`,
            `export const model = ${JSON.stringify(apiConfig.model)};`,
            `export const prompt = ${JSON.stringify(prompt)};`,
            `export const result = ${JSON.stringify(content)};`,
            ''
        ].join('\n'),
        'utf-8'
    );

    console.log(`[Signal-Zero] Wrote ${outputPath}`);
}
