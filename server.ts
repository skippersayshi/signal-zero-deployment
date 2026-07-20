import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import { executeOrchestratedSwarm, OrchestratorRoleConfig } from './v2-errorhandling';

type ApiConfig = {
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
    status: string;
};

type MultiModelConfig = ApiConfig & {
    id?: string;
};

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function createRunnerCode(prompt: string, outputPath: string, contextPath: string, config: Omit<ApiConfig, 'apiKey' | 'status'>): string {
    return [
        "import { executeTestSwarm } from './v2-errorhandling';",
        'const apiConfig = {',
        `    provider: ${JSON.stringify(config.provider)},`,
        `    model: ${JSON.stringify(config.model)},`,
        `    baseUrl: ${JSON.stringify(config.baseUrl)},`,
        "    apiKey: process.env.SWARM_API_KEY || ''",
        '};',
        `executeTestSwarm(${JSON.stringify(prompt)}, ${JSON.stringify(outputPath)}, ${JSON.stringify(contextPath)}, apiConfig)`,
        '    .then(() => process.exit(0))',
        '    .catch((err) => { console.error(err); process.exit(1); });',
        ''
    ].join('\n');
}

function spawnRunner(runnerFile: string, apiKey = ''): ChildProcess {
    return spawn(process.execPath, ['--loader', 'ts-node/esm', '--experimental-specifier-resolution=node', runnerFile], {
        env: { ...process.env, SWARM_API_KEY: apiKey },
        windowsHide: true
    });
}

// Load environment variables from .env file
async function initEnv() {
    try {
        const dotenv = await import('dotenv');
        if (dotenv.config) {
            dotenv.config();
        } else if (dotenv.default && dotenv.default.config) {
            dotenv.default.config();
        }
    } catch (e) {
        console.log('⚠️ dotenv not configured, proceeding with existing environment');
    }
}

await initEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

let activeProcess: ChildProcess | null = null;
let activeProcesses: Map<string, ChildProcess> = new Map();
let activeOrchestration = false;

let apiConfig: ApiConfig = {
    provider: 'openai',
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    status: 'unchecked'
};

// Multiple API configs for parallel execution
let multiApiConfigs: MultiModelConfig[] = [];

const API_CONFIG_FILE = 'api-config.json';
const ORCHESTRATOR_OUTPUT_FILE = './output/orchestrated-module.ts';

function findConfig(provider: string, model?: string): MultiModelConfig | ApiConfig | undefined {
    const providerLower = provider.toLowerCase();
    return multiApiConfigs.find((config) => {
        const providerMatches = config.provider.toLowerCase() === providerLower;
        return providerMatches && (!model || config.model === model);
    }) || (apiConfig.provider.toLowerCase() === providerLower && (!model || apiConfig.model === model) ? apiConfig : undefined);
}

function requireConfig(provider: string, model: string, fallbackModel?: string): MultiModelConfig | ApiConfig {
    const config = findConfig(provider, model) || (fallbackModel ? findConfig(provider, fallbackModel) : undefined) || findConfig(provider);
    if (!config || !config.apiKey) {
        throw new Error(`Missing API configuration for ${provider}/${model}`);
    }
    return config;
}

function buildHighPerformanceRoles(): OrchestratorRoleConfig[] {
    const openRouterOrchestrator = requireConfig('openrouter', 'anthropic/claude-opus-4.8');
    const openRouterBuilder = requireConfig('openrouter', 'deepseek/deepseek-v4-pro');
    const reviewer = findConfig('google', 'models/gemini-pro-latest') || findConfig('openrouter', 'google/gemini-3.1-pro-preview');

    if (!reviewer || !reviewer.apiKey) {
        throw new Error('Missing reviewer API configuration for Google Gemini or OpenRouter Gemini');
    }

    return [
        {
            role: 'orchestrator',
            label: 'Claude Opus via OpenRouter',
            provider: 'openrouter',
            model: 'anthropic/claude-opus-4.8',
            baseUrl: openRouterOrchestrator.baseUrl,
            apiKey: openRouterOrchestrator.apiKey
        },
        {
            role: 'builder',
            label: 'DeepSeek V4 Pro via OpenRouter',
            provider: 'openrouter',
            model: 'deepseek/deepseek-v4-pro',
            baseUrl: openRouterBuilder.baseUrl,
            apiKey: openRouterBuilder.apiKey
        },
        {
            role: 'reviewer',
            label: reviewer.provider === 'google' ? 'Gemini Pro direct' : 'Gemini Pro via OpenRouter',
            provider: reviewer.provider,
            model: reviewer.provider === 'google' ? 'models/gemini-pro-latest' : 'google/gemini-3.1-pro-preview',
            baseUrl: reviewer.baseUrl,
            apiKey: reviewer.apiKey
        }
    ];
}

function publicRoles(roles: OrchestratorRoleConfig[]) {
    return roles.map(({ role, label, provider, model, baseUrl }) => ({ role, label, provider, model, baseUrl }));
}

// Load API config on startup
async function loadApiConfig() {
    try {
        const data = await fs.readFile(API_CONFIG_FILE, 'utf-8');
        const loaded = JSON.parse(data);
        
        // If api-config.json has apiConfigs array, use primary config
        if (loaded.apiConfigs && Array.isArray(loaded.apiConfigs)) {
            multiApiConfigs = loaded.apiConfigs;
            if (loaded.primary) {
                apiConfig = { ...apiConfig, ...loaded.primary };
            } else if (loaded.apiConfigs.length > 0) {
                apiConfig = { ...apiConfig, ...loaded.apiConfigs[0] };
            }
        } else {
            apiConfig = { ...apiConfig, ...loaded };
        }
        
        console.log('✅ API config loaded:', { ...apiConfig, apiKey: '***' });
        console.log(`📋 Available API configs: ${multiApiConfigs.length}`);
    } catch (error) {
        // Try to load from environment variables
        console.log('📌 Loading API configuration from environment variables...');
        
        // Try OpenAI first (most common)
        if (process.env.OPENAI_API_KEY) {
            apiConfig = {
                provider: 'openai',
                apiKey: process.env.OPENAI_API_KEY,
                baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
                model: process.env.OPENAI_MODEL || 'gpt-5.5',
                status: 'configured'
            };
            console.log('✅ Loaded OpenAI from .env');
        }
        
        // Build multi-config from environment
        const envConfigs: Array<{id: string, provider: string, model: string, apiKey: string, baseUrl: string, status: string}> = [];
        
        if (process.env.OPENAI_API_KEY) {
            envConfigs.push({
                id: 'openai-primary',
                provider: 'openai',
                model: process.env.OPENAI_MODEL || 'gpt-5.5',
                apiKey: process.env.OPENAI_API_KEY,
                baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
                status: 'configured'
            });
        }
        
        if (process.env.OPENROUTER_API_KEY_PRIMARY) {
            envConfigs.push({
                id: 'openrouter-primary',
                provider: 'openrouter',
                model: 'openai/gpt-5.5',
                apiKey: process.env.OPENROUTER_API_KEY_PRIMARY,
                baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
                status: 'configured'
            });
        }
        
        if (process.env.MISTRAL_API_KEY) {
            envConfigs.push({
                id: 'mistral-primary',
                provider: 'mistral',
                model: 'mistral-large-latest',
                apiKey: process.env.MISTRAL_API_KEY,
                baseUrl: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1',
                status: 'configured'
            });
        }
        
        if (process.env.GROQ_API_KEY) {
            envConfigs.push({
                id: 'groq-primary',
                provider: 'groq',
                model: 'llama-3.3-70b-versatile',
                apiKey: process.env.GROQ_API_KEY,
                baseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
                status: 'configured'
            });
        }
        
        if (process.env.GOOGLE_API_KEY) {
            envConfigs.push({
                id: 'google-primary',
                provider: 'google',
                model: 'models/gemini-pro-latest',
                apiKey: process.env.GOOGLE_API_KEY,
                baseUrl: process.env.GOOGLE_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
                status: 'configured'
            });
        }
        
        if (envConfigs.length > 0) {
            multiApiConfigs = envConfigs;
            console.log(`✅ Loaded ${envConfigs.length} API configurations from .env`);
        } else {
            console.log('⚠️  No API config found, using defaults.');
        }
    }
}

// Frontend is now served from public/index.html (moved out of source to avoid template literal issues)

// 2. Routing & API Endpoints
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get API config
app.get('/api/config', (req, res) => {
    res.json({
        provider: apiConfig.provider,
        model: apiConfig.model,
        baseUrl: apiConfig.baseUrl,
        apiKey: apiConfig.apiKey ? '***' : '',
        status: apiConfig.status
    });
});

app.get('/api/orchestrator/preset', (req, res) => {
    try {
        res.json({
            mode: 'high-performance',
            roles: publicRoles(buildHighPerformanceRoles())
        });
    } catch (error) {
        res.status(400).json({ error: getErrorMessage(error) });
    }
});

// Save API config
app.post('/api/config', async (req, res) => {
    const { provider, model, apiKey, baseUrl } = req.body;
    
    apiConfig = {
        provider: provider || 'openai',
        model: model || 'gpt-4o',
        baseUrl: baseUrl || 'https://api.openai.com/v1',
        apiKey: apiKey || '',
        status: 'unchecked'
    };

    try {
        await fs.writeFile(API_CONFIG_FILE, JSON.stringify(apiConfig, null, 2), 'utf-8');
        io.emit('api-config-updated', { provider: apiConfig.provider, model: apiConfig.model });
        res.json({ success: true, message: 'API config saved' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// Test API connection
app.post('/api/test', async (req, res) => {
    const { provider, model, apiKey, baseUrl } = req.body;

    if (!apiKey) {
        return res.status(400).json({ message: 'API Key is required' });
    }

    try {
        const startTime = Date.now();
        
        // Test different providers
        let testResult = false;
        let errorMessage = '';

        if (provider === 'openai') {
            try {
                const url = (baseUrl || 'https://api.openai.com/v1') + '/models';
                const response = await fetch(url, {
                    headers: {
                        'Authorization': 'Bearer ' + apiKey,
                        'Content-Type': 'application/json'
                    }
                });
                testResult = response.ok;
                if (!testResult) {
                    const error = await response.json() as { error?: { message?: string } };
                    errorMessage = error.error?.message || 'Invalid API Key';
                }
            } catch (error) {
                errorMessage = getErrorMessage(error);
            }
        } else if (provider === 'anthropic') {
            try {
                const response = await fetch('https://api.anthropic.com/v1/models', {
                    headers: {
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01'
                    }
                });
                testResult = response.ok;
                if (!testResult) {
                    errorMessage = 'Invalid Anthropic API Key';
                }
            } catch (error) {
                errorMessage = getErrorMessage(error);
            }
        } else if (provider === 'google') {
            try {
                const url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey;
                const response = await fetch(url);
                testResult = response.ok;
                if (!testResult) {
                    errorMessage = 'Invalid Google API Key';
                }
            } catch (error) {
                errorMessage = getErrorMessage(error);
            }
        } else {
            testResult = true; // Custom/local API
        }

        const latency = Date.now() - startTime;

        if (testResult) {
            apiConfig.status = 'success';
            res.json({
                success: true,
                status: 'success',
                latency: latency,
                message: 'API connection successful (' + latency + 'ms)'
            });
        } else {
            apiConfig.status = 'failed';
            res.status(400).json({
                success: false,
                status: 'failed',
                message: errorMessage || 'API test failed'
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error testing API: ' + getErrorMessage(error)
        });
    }
});

app.post('/api/start', async (req, res) => {
    if (activeProcess) return res.status(400).json({ error: 'Swarm is al actief.' });
    
    const { prompt, context, apiProvider, apiModel } = req.body;
    
    try {
        // Update swarm logic based on detected model change
        const modelChanged = apiConfig.model !== apiModel;
        const providerChanged = apiConfig.provider !== apiProvider;

        if (modelChanged || providerChanged) {
            io.emit('stdout', '\n[System] 🔄 Model change detected: ' + apiProvider + '/' + apiModel + '\n');
            io.emit('stdout', '[System] ⚙️ Adjusting swarm logic for optimal ' + apiModel + ' performance...\n');
            
            // Store for swarm process
            apiConfig.model = apiModel;
            apiConfig.provider = apiProvider;
        }

        await fs.writeFile('test-context.txt', context || 'Geen context', 'utf-8');
        
        const runnerCode = createRunnerCode(prompt, './output/generated-module.ts', './test-context.txt', {
            provider: apiProvider,
            model: apiModel,
            baseUrl: apiConfig.baseUrl
        });
            
        await fs.writeFile('temp-runner.ts', runnerCode, 'utf-8');

        // Start het proces
        activeProcess = spawnRunner('temp-runner.ts', apiConfig.apiKey);

        activeProcess.stdout?.on('data', (data) => io.emit('stdout', data.toString()));
        activeProcess.stderr?.on('data', (data) => io.emit('stderr', data.toString()));

        activeProcess.on('close', (code) => {
            io.emit('status', 'Swarm proces afgesloten (Code: ' + code + ')');
            activeProcess = null;
        });

        res.json({ message: 'Swarm gestart.' });
    } catch (error) {
        res.status(500).json({ error: 'Fout bij starten van Swarm.' });
    }
});

app.post('/api/start-orchestrator', async (req, res) => {
    if (activeOrchestration) {
        return res.status(400).json({ error: 'Orchestrator is al actief.' });
    }

    const { prompt, context } = req.body as { prompt: string; context?: string };
    if (!prompt || !prompt.trim()) {
        return res.status(400).json({ error: 'Prompt is required' });
    }

    try {
        const roles = buildHighPerformanceRoles();
        await fs.writeFile('test-context.txt', context || 'Geen context', 'utf-8');
        activeOrchestration = true;

        io.emit('stdout', '\n[System] Starting high-performance orchestrator pipeline.\n');
        publicRoles(roles).forEach((role) => {
            io.emit('stdout', `[System] ${role.role}: ${role.label} (${role.provider}/${role.model})\n`);
        });

        void executeOrchestratedSwarm(
            prompt,
            ORCHESTRATOR_OUTPUT_FILE,
            './test-context.txt',
            roles,
            (message) => io.emit('stdout', message + '\n')
        )
            .then(() => {
                io.emit('status', `Orchestrator pipeline afgesloten. Output: ${ORCHESTRATOR_OUTPUT_FILE}`);
            })
            .catch((error) => {
                io.emit('stderr', `[Orchestrator] ${getErrorMessage(error)}\n`);
                io.emit('status', 'Orchestrator pipeline afgesloten met fouten.');
            })
            .finally(() => {
                activeOrchestration = false;
            });

        res.json({ message: 'Orchestrator gestart.', roles: publicRoles(roles) });
    } catch (error) {
        activeOrchestration = false;
        res.status(500).json({ error: 'Fout bij starten van orchestrator: ' + getErrorMessage(error) });
    }
});

// Start multiple models in parallel
app.post('/api/start-multi', async (req, res) => {
    const { prompt, context, multiModels } = req.body as { prompt: string; context?: string; multiModels?: MultiModelConfig[] };
    
    if (!multiModels || multiModels.length === 0) {
        return res.status(400).json({ error: 'No models provided' });
    }

    try {
        io.emit('stdout', '\n[System] 🚀 Initiating parallel swarm with ' + multiModels.length + ' models (July 2026)\n');
        io.emit('stdout', '[System] Models: ' + multiModels.map((m) => m.model).join(', ') + '\n\n');

        await fs.writeFile('test-context.txt', context || 'Geen context', 'utf-8');

        // Start each model in parallel
        multiModels.forEach((modelConfig, index) => {
            const processId = 'model-' + index + '-' + Date.now();
            
            io.emit('stdout', '[System] ⚡ Starting [' + (index + 1) + '/' + multiModels.length + '] ' + modelConfig.provider + '/' + modelConfig.model + '...\n');
            
            const runnerCode = createRunnerCode(prompt, './output/generated-module-' + index + '.ts', './test-context.txt', {
                provider: modelConfig.provider,
                model: modelConfig.model,
                baseUrl: modelConfig.baseUrl
            });
                
            const runnerFile = 'temp-runner-' + index + '.ts';
            fs.writeFile(runnerFile, runnerCode, 'utf-8').then(() => {
                const childProcess = spawnRunner(runnerFile, modelConfig.apiKey);
                activeProcesses.set(processId, childProcess);

                childProcess.stdout?.on('data', (data) => {
                    io.emit('stdout', '[Model ' + index + '] ' + data.toString());
                });
                childProcess.stderr?.on('data', (data) => {
                    io.emit('stderr', '[Model ' + index + '] ' + data.toString());
                });

                childProcess.on('close', (code) => {
                    io.emit('stdout', '[System] ✅ Model ' + index + ' completed (Code: ' + code + ')\n');
                    activeProcesses.delete(processId);
                });
            });
        });

        res.json({ message: 'Multi-model swarm gestart', models: multiModels.length });
    } catch (error) {
        res.status(500).json({ error: 'Fout bij starten van multi-model swarm: ' + getErrorMessage(error) });
    }
});

app.post('/api/stop', (req, res) => {
    if (activeProcess) {
        activeProcess.kill('SIGKILL');
        activeProcess = null;
    }
    
    // Stop all active processes
    activeProcesses.forEach((process, id) => {
        process.kill('SIGKILL');
    });
    activeProcesses.clear();
    activeOrchestration = false;
    
    io.emit('stderr', '\n🚨 Noodstop geactiveerd: Alle processen afgesloten door gebruiker.\n');
    res.json({ message: 'Alle processen afgebroken.' });
});

// 3. Server Start
const PORT = 3088;

// Initialize and start server
async function startServer() {
    await loadApiConfig();
    
    httpServer.listen(PORT, () => {
        console.log(`\n🌐 Signal-Zero Dashboard live op: http://localhost:${PORT}`);
        console.log(`🔌 API Provider: ${apiConfig.provider}`);
        console.log(`🤖 Model: ${apiConfig.model}`);
    });
}

startServer();
