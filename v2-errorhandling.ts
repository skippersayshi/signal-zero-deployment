import * as fs from 'fs/promises';
import * as path from 'path';

export type SwarmApiConfig = {
    provider: string;
    model: string;
    baseUrl?: string;
    apiKey?: string;
};

export type OrchestratorRoleConfig = SwarmApiConfig & {
    role: 'orchestrator' | 'builder' | 'reviewer';
    label: string;
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
    const model = config.model.replace(/^models\//, '');
    const response = await fetch(`${baseUrl}/models/${model}:generateContent?key=${apiKey}`, {
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

export async function generateWithProvider(prompt: string, context: string, config: SwarmApiConfig): Promise<string | null> {
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

function requireRole(roles: OrchestratorRoleConfig[], role: OrchestratorRoleConfig['role']): OrchestratorRoleConfig {
    const config = roles.find((item) => item.role === role);
    if (!config) {
        throw new Error(`Missing ${role} role configuration`);
    }
    return config;
}

function hasFailureSignal(review: string): boolean {
    return /\b(fail|failed|reject|rejected|error|invalid|niet akkoord|afgekeurd)\b/i.test(review);
}

export async function executeOrchestratedSwarm(
    prompt: string,
    outputPath: string,
    contextPath: string,
    roles: OrchestratorRoleConfig[],
    log: (message: string) => void = console.log
): Promise<void> {
    const context = await fs.readFile(contextPath, 'utf-8').catch(() => '');
    const orchestrator = requireRole(roles, 'orchestrator');
    const builder = requireRole(roles, 'builder');
    const reviewer = requireRole(roles, 'reviewer');

    log(`[Signal-Zero] Orchestrator: ${orchestrator.label} (${orchestrator.provider}/${orchestrator.model})`);
    const blueprintPrompt = [
        'You are the Signal-Zero Orchestrator.',
        'Produce a compact technical blueprint. Do not write implementation code.',
        'Separate assumptions, interfaces, implementation steps, validation criteria, and edge cases.',
        '',
        `User task:\n${prompt}`
    ].join('\n');
    const blueprint = await generateWithProvider(blueprintPrompt, context, orchestrator)
        || createFallback(blueprintPrompt, context, orchestrator);

    log(`[Signal-Zero] Builder: ${builder.label} (${builder.provider}/${builder.model})`);
    const buildPrompt = [
        'You are the Signal-Zero Builder.',
        'Implement the requested TypeScript/Node output by following the blueprint exactly.',
        'Return the implementation plus short notes about important decisions.',
        '',
        `Blueprint:\n${blueprint}`,
        '',
        `User task:\n${prompt}`
    ].join('\n');
    let implementation = await generateWithProvider(buildPrompt, context, builder)
        || createFallback(buildPrompt, context, builder);

    log(`[Signal-Zero] Reviewer: ${reviewer.label} (${reviewer.provider}/${reviewer.model})`);
    const reviewPrompt = [
        'You are the Signal-Zero Reviewer.',
        'Audit the implementation against the original context and blueprint.',
        'Return PASS when it satisfies the blueprint. Return FAIL plus concrete repair instructions otherwise.',
        '',
        `Blueprint:\n${blueprint}`,
        '',
        `Implementation:\n${implementation}`
    ].join('\n');
    const review = await generateWithProvider(reviewPrompt, context, reviewer)
        || 'FAIL: reviewer unavailable; deterministic fallback requested a repair pass.';

    let finalReview = review;
    if (hasFailureSignal(review)) {
        log('[Signal-Zero] Reviewer requested a repair pass.');
        const repairPrompt = [
            'You are the Signal-Zero Builder.',
            'Repair the implementation using the reviewer feedback. Return the corrected implementation only.',
            '',
            `Blueprint:\n${blueprint}`,
            '',
            `Previous implementation:\n${implementation}`,
            '',
            `Reviewer feedback:\n${review}`
        ].join('\n');
        implementation = await generateWithProvider(repairPrompt, context, builder) || implementation;
        finalReview = await generateWithProvider(
            `Re-audit this repaired implementation. Return PASS or FAIL with concise reasons.\n\n${implementation}`,
            context,
            reviewer
        ) || finalReview;
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(
        outputPath,
        [
            '// Generated by Signal-Zero orchestrator.',
            `export const generatedAt = ${JSON.stringify(new Date().toISOString())};`,
            `export const roles = ${JSON.stringify(roles.map(({ role, label, provider, model }) => ({ role, label, provider, model })), null, 2)};`,
            `export const prompt = ${JSON.stringify(prompt)};`,
            `export const blueprint = ${JSON.stringify(blueprint)};`,
            `export const implementation = ${JSON.stringify(implementation)};`,
            `export const review = ${JSON.stringify(finalReview)};`,
            ''
        ].join('\n'),
        'utf-8'
    );

    log(`[Signal-Zero] Orchestrated output written to ${outputPath}`);
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
