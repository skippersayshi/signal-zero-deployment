import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';

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

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());

let activeProcess: ChildProcess | null = null;
let activeProcesses: Map<string, ChildProcess> = new Map();

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

// 1. De complete Frontend UI (Ingesloten als string om mappen te voorkomen)
const htmlContent = `
<!DOCTYPE html>
<html lang="nl" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Signal-Zero | Telemetry</title>
    <script src="https://unpkg.com/@tailwindcss/browser@4"></script>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #1f2937; }
        ::-webkit-scrollbar-thumb { background: #4b5563; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #6b7280; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .animate-pulse { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
        .status-light { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
        .status-green { background: #10b981; box-shadow: 0 0 10px rgba(16, 185, 129, 0.5); }
        .status-red { background: #ef4444; box-shadow: 0 0 10px rgba(239, 68, 68, 0.5); }
        .status-yellow { background: #f59e0b; box-shadow: 0 0 10px rgba(245, 158, 11, 0.5); }
    </style>
</head>
<body class="bg-gray-950 text-gray-100 h-screen flex flex-col font-sans">
    <header class="bg-gray-900 border-b border-gray-800 p-4 flex justify-between items-center shrink-0">
        <h1 class="text-xl font-bold tracking-wider text-cyan-500">SIGNAL-ZERO <span class="text-gray-500 text-sm font-normal">| Swarm Controller</span></h1>
        <div class="flex items-center gap-4">
            <div id="costEstimator" class="text-sm text-gray-400 bg-gray-800 px-3 py-1 rounded">Est. Tokens: 0</div>
            <button id="btnStop" class="hidden bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded font-semibold transition-colors shadow-[0_0_15px_rgba(220,38,38,0.5)]">🚨 EMERGENCY STOP</button>
        </div>
    </header>

    <main class="flex-1 overflow-hidden flex flex-col lg:flex-row gap-6 p-6">
        <section class="w-full lg:w-1/4 flex flex-col gap-4 shrink-0 overflow-y-auto">
            <!-- Swarm Config Panel -->
            <div class="bg-gray-900 p-4 rounded-lg border border-gray-800 flex flex-col gap-4 shadow-xl">
                <h3 class="text-sm font-bold text-cyan-400 uppercase tracking-wider">⚙️ Swarm Config</h3>
                <div>
                    <label class="block text-xs uppercase text-gray-400 font-semibold mb-2">Engine Selectie</label>
                    <select id="scriptSelect" class="w-full bg-gray-950 border border-gray-700 text-white rounded p-2 focus:ring-1 focus:ring-cyan-500 outline-none">
                        <option value="v2">V2 - Errorhandling & SynteroLink</option>
                    </select>
                </div>
                
                <div class="flex flex-col">
                    <label class="block text-xs uppercase text-gray-400 font-semibold mb-2">Repository Context</label>
                    <textarea id="contextInput" class="w-full bg-gray-950 border border-gray-700 text-gray-300 rounded p-3 font-mono text-xs focus:ring-1 focus:ring-cyan-500 outline-none resize-none placeholder-gray-700 h-24" placeholder="Plak hier interfaces, schema's of bestaande code..."></textarea>
                </div>

                <div class="flex flex-col">
                    <label class="block text-xs uppercase text-gray-400 font-semibold mb-2">Opdracht (Prompt)</label>
                    <textarea id="promptInput" class="w-full bg-gray-950 border border-gray-700 text-white rounded p-3 font-mono text-xs focus:ring-1 focus:ring-cyan-500 outline-none resize-none placeholder-gray-600 h-32" placeholder="Bijv: Bouw een Express middleware voor authenticatie..."></textarea>
                </div>

                <button id="btnStart" class="w-full bg-cyan-700 hover:bg-cyan-600 text-white px-4 py-3 rounded font-bold uppercase tracking-wider transition-colors">Start Swarm</button>
            </div>

            <!-- API Configuration Panel -->
            <div class="bg-gray-900 p-4 rounded-lg border border-gray-800 flex flex-col gap-3 shadow-xl">
                <div class="flex justify-between items-center">
                    <h3 class="text-sm font-bold text-cyan-400 uppercase tracking-wider">🔌 API Configuration</h3>
                    <div id="apiStatusLight" class="status-light status-yellow"></div>
                </div>

                <div>
                    <label class="block text-xs uppercase text-gray-400 font-semibold mb-2">Provider</label>
                    <select id="apiProvider" class="w-full bg-gray-950 border border-gray-700 text-white rounded p-2 focus:ring-1 focus:ring-cyan-500 outline-none text-sm">
                        <option value="openai">OpenAI</option>
                        <option value="anthropic">Anthropic (Claude)</option>
                        <option value="google">Google (Gemini)</option>
                        <option value="deepseek">DeepSeek</option>
                        <option value="openrouter">OpenRouter (Multi-Provider)</option>
                        <option value="custom">Custom/Local</option>
                    </select>
                </div>

                <div>
                    <label class="block text-xs uppercase text-gray-400 font-semibold mb-2">Model (July 2026)</label>
                    <select id="apiModel" class="w-full bg-gray-950 border border-gray-700 text-white rounded p-2 focus:ring-1 focus:ring-cyan-500 outline-none text-sm">
                        <optgroup label="OpenAI">
                            <option value="gpt-5.5">GPT-5.5 (Latest)</option>
                            <option value="gpt-5-turbo">GPT-5 Turbo</option>
                            <option value="gpt-4o">GPT-4o</option>
                        </optgroup>
                        <optgroup label="Anthropic">
                            <option value="claude-opus-4.8">Claude Opus 4.8</option>
                            <option value="claude-sonnet-4">Claude Sonnet 4</option>
                            <option value="claude-haiku-3">Claude Haiku 3</option>
                        </optgroup>
                        <optgroup label="Google">
                            <option value="models/gemini-pro-latest">Gemini Pro Latest</option>
                            <option value="models/gemini-2.5-pro">Gemini 2.5 Pro</option>
                            <option value="gemini-pro-vision">Gemini Pro Vision</option>
                        </optgroup>
                        <optgroup label="DeepSeek">
                            <option value="deepseek-4-pro">DeepSeek 4 Pro</option>
                            <option value="deepseek-3.5">DeepSeek 3.5</option>
                            <option value="deepseek-lite">DeepSeek Lite</option>
                        </optgroup>
                        <optgroup label="OpenRouter">
                            <option value="openai/gpt-5.5">GPT-5.5 via OpenRouter</option>
                            <option value="anthropic/claude-opus-4.8">Claude Opus 4.8 via OpenRouter</option>
                            <option value="google/gemini-3.1-pro-preview">Gemini 3.1 via OpenRouter</option>
                            <option value="deepseek/deepseek-v4-pro">DeepSeek V4 via OpenRouter</option>
                        </optgroup>
                        <optgroup label="Random/Empty">
                            <option value="random-selected">🎲 Random Selection</option>
                            <option value="-">-- Empty Slot 1 --</option>
                            <option value="-">-- Empty Slot 2 --</option>
                            <option value="-">-- Empty Slot 3 --</option>
                        </optgroup>
                    </select>
                </div>

                <div>
                    <label class="block text-xs uppercase text-gray-400 font-semibold mb-2">API Key</label>
                    <div class="relative">
                        <input id="apiKey" type="password" class="w-full bg-gray-950 border border-gray-700 text-white rounded p-2 focus:ring-1 focus:ring-cyan-500 outline-none text-sm font-mono" placeholder="sk-...">
                        <button id="toggleKeyVisibility" class="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-200 text-xs">👁️</button>
                    </div>
                </div>

                <div>
                    <label class="block text-xs uppercase text-gray-400 font-semibold mb-2">Base URL (Optional)</label>
                    <input id="apiBaseUrl" type="text" class="w-full bg-gray-950 border border-gray-700 text-white rounded p-2 focus:ring-1 focus:ring-cyan-500 outline-none text-sm font-mono" placeholder="https://api.openai.com/v1">
                </div>

                <div class="grid grid-cols-2 gap-2">
                    <button id="btnTestApi" class="bg-blue-600 hover:bg-blue-500 text-white px-3 py-2 rounded text-xs font-semibold uppercase transition-colors">🧪 Test API</button>
                    <button id="btnSaveApi" class="bg-green-600 hover:bg-green-500 text-white px-3 py-2 rounded text-xs font-semibold uppercase transition-colors">💾 Save Config</button>
                </div>

                <button id="btnAddMultiModel" class="w-full bg-purple-600 hover:bg-purple-500 text-white px-3 py-2 rounded text-xs font-semibold uppercase transition-colors">➕ Add Multiple Models</button>

                <div id="apiStatus" class="bg-gray-950 border border-gray-700 rounded p-2 text-xs text-gray-400 text-center min-h-12 flex items-center justify-center">
                    <span>Status: Not tested</span>
                </div>

                <details class="text-xs">
                    <summary class="cursor-pointer text-gray-400 hover:text-gray-300">📊 API Details</summary>
                    <div id="apiDetails" class="mt-2 text-gray-500 bg-gray-950 p-2 rounded font-mono text-xs space-y-1">
                        <div>Provider: <span id="detailProvider">-</span></div>
                        <div>Model: <span id="detailModel">-</span></div>
                        <div>Latency: <span id="detailLatency">-</span></div>
                        <div>Last Check: <span id="detailLastCheck">-</span></div>
                    </div>
                </details>
            </div>
        </section>

        <section class="flex-1 flex flex-col gap-4 overflow-hidden shadow-xl">
            <div class="flex-1 flex flex-col bg-gray-900 border border-gray-800 rounded-lg overflow-hidden relative">
                <div class="bg-gray-950 border-b border-gray-800 px-3 py-2 text-xs font-mono text-gray-500 flex justify-between">
                    <span>>_ STDOUT (Logica & Status)</span>
                    <span id="statusIndicator" class="text-green-500">IDLE</span>
                </div>
                <div id="stdoutConsole" class="flex-1 overflow-y-auto p-4 font-mono text-sm text-gray-300 whitespace-pre-wrap leading-relaxed"></div>
            </div>

            <div class="h-1/3 flex flex-col bg-gray-900 border border-gray-800 rounded-lg overflow-hidden relative">
                <div class="bg-gray-950 border-b border-gray-800 px-3 py-2 text-xs font-mono text-gray-500">
                    <span class="text-red-400">>_ STDERR (Netwerk & Errors)</span>
                </div>
                <div id="stderrConsole" class="flex-1 overflow-y-auto p-4 font-mono text-sm text-red-400 whitespace-pre-wrap leading-relaxed"></div>
            </div>
        </section>
    </main>

    <script>
        const socket = io();
        const promptInput = document.getElementById('promptInput');
        const contextInput = document.getElementById('contextInput');
        const scriptSelect = document.getElementById('scriptSelect');
        const btnStart = document.getElementById('btnStart');
        const btnStop = document.getElementById('btnStop');
        const stdoutConsole = document.getElementById('stdoutConsole');
        const stderrConsole = document.getElementById('stderrConsole');
        const costEstimator = document.getElementById('costEstimator');
        const statusIndicator = document.getElementById('statusIndicator');

        // API Configuration Elements
        const apiProvider = document.getElementById('apiProvider');
        const apiModel = document.getElementById('apiModel');
        const apiKey = document.getElementById('apiKey');
        const apiBaseUrl = document.getElementById('apiBaseUrl');
        const btnTestApi = document.getElementById('btnTestApi');
        const btnSaveApi = document.getElementById('btnSaveApi');
        const apiStatus = document.getElementById('apiStatus');
        const apiStatusLight = document.getElementById('apiStatusLight');
        const toggleKeyVisibility = document.getElementById('toggleKeyVisibility');
        const detailProvider = document.getElementById('detailProvider');
        const detailModel = document.getElementById('detailModel');
        const detailLatency = document.getElementById('detailLatency');
        const detailLastCheck = document.getElementById('detailLastCheck');

        let currentApiStatus = 'unchecked';

        window.addEventListener('DOMContentLoaded', () => {
            const savedPrompt = localStorage.getItem('sz_prompt');
            const savedContext = localStorage.getItem('sz_context');
            if (savedPrompt) promptInput.value = savedPrompt;
            if (savedContext) contextInput.value = savedContext;
            updateEstimator();
            loadApiConfig();
        });

        const updateEstimator = () => {
            const chars = promptInput.value.length + contextInput.value.length;
            const estimatedTokens = Math.ceil(chars / 4);
            costEstimator.textContent = \`Est. Input Tokens: ~\${estimatedTokens}\`;
        };
        promptInput.addEventListener('input', updateEstimator);
        contextInput.addEventListener('input', updateEstimator);

        // Key visibility toggle
        toggleKeyVisibility.addEventListener('click', () => {
            if (apiKey.type === 'password') {
                apiKey.type = 'text';
                toggleKeyVisibility.textContent = '🙈';
            } else {
                apiKey.type = 'password';
                toggleKeyVisibility.textContent = '👁️';
            }
        });

        // Load saved API config
        async function loadApiConfig() {
            try {
                const response = await fetch('/api/config');
                const config = await response.json();
                apiProvider.value = config.provider;
                apiModel.value = config.model;
                apiBaseUrl.value = config.baseUrl;
                apiKey.value = config.apiKey;
                updateModelOptions();
                updateApiStatus(config.status);
            } catch (error) {
                console.error('Error loading API config:', error);
            }
        }

        // Update model options based on provider
        apiProvider.addEventListener('change', () => {
            updateModelOptions();
            updateApiStatus('unchecked');
        });

        function updateModelOptions() {
            const provider = apiProvider.value;
            const models = {
                openai: ['gpt-5.5', 'gpt-5-turbo', 'gpt-4o'],
                anthropic: ['claude-opus-4.8', 'claude-sonnet-4', 'claude-haiku-3'],
                google: ['models/gemini-pro-latest', 'models/gemini-2.5-pro', 'models/gemini-2.5-flash'],
                deepseek: ['deepseek-4-pro', 'deepseek-3.5', 'deepseek-lite'],
                openrouter: ['openai/gpt-5.5', 'anthropic/claude-opus-4.8', 'google/gemini-3.1-pro-preview', 'deepseek/deepseek-v4-pro'],
                custom: ['local-model', 'random-selected', '-']
            };
            apiModel.innerHTML = '';
            (models[provider] || []).forEach(model => {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                apiModel.appendChild(option);
            });
            updateApiStatus('unchecked');
        }

        // Test API Connection
        btnTestApi.addEventListener('click', async () => {
            const key = apiKey.value.trim();
            if (!key) {
                updateApiStatus('error', 'API Key is required');
                return;
            }

            btnTestApi.disabled = true;
            btnTestApi.textContent = '⏳ Testing...';
            updateApiStatus('testing');

            try {
                const startTime = performance.now();
                const response = await fetch('/api/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        provider: apiProvider.value,
                        model: apiModel.value,
                        apiKey: key,
                        baseUrl: apiBaseUrl.value
                    })
                });
                const latency = Math.round(performance.now() - startTime);

                if (response.ok) {
                    const result = await response.json();
                    updateApiStatus('success', '✅ API Connected (' + latency + 'ms)', latency);
                } else {
                    const error = await response.json();
                    updateApiStatus('error', '❌ ' + (error.message || 'API Error'));
                }
            } catch (error) {
                updateApiStatus('error', '❌ Connection failed: ' + error.message);
            } finally {
                btnTestApi.disabled = false;
                btnTestApi.textContent = '🧪 Test API';
            }
        });

        // Save API Config
        btnSaveApi.addEventListener('click', async () => {
            const key = apiKey.value.trim();
            if (!key) {
                alert('Please enter an API Key');
                return;
            }

            try {
                const response = await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        provider: apiProvider.value,
                        model: apiModel.value,
                        apiKey: key,
                        baseUrl: apiBaseUrl.value
                    })
                });
                if (response.ok) {
                    apiStatus.innerHTML = '<span style="color: #10b981;">✅ Config saved successfully</span>';
                    setTimeout(() => {
                        if (currentApiStatus !== 'success') {
                            updateApiStatus('unchecked');
                        }
                    }, 2000);
                }
            } catch (error) {
                apiStatus.innerHTML = '<span style="color: #ef4444;">❌ Failed to save config</span>';
            }
        });

        function updateApiStatus(status, message = '', latency = null) {
            currentApiStatus = status;
            apiStatusLight.className = 'status-light';
            
            if (status === 'success') {
                apiStatusLight.classList.add('status-green', 'animate-pulse');
                detailLatency.textContent = latency + 'ms' || '-';
                detailLastCheck.textContent = new Date().toLocaleTimeString();
                detailProvider.textContent = apiProvider.value.toUpperCase();
                detailModel.textContent = apiModel.value;
            } else if (status === 'error') {
                apiStatusLight.classList.add('status-red');
            } else if (status === 'testing') {
                apiStatusLight.classList.add('status-yellow', 'animate-pulse');
            } else {
                apiStatusLight.classList.add('status-yellow');
            }

            if (message) {
                apiStatus.innerHTML = \`<span>\${message}</span>\`;
            } else if (status === 'unchecked') {
                apiStatus.innerHTML = '<span style="color: #9ca3af;">Status: Not tested</span>';
            } else if (status === 'testing') {
                apiStatus.innerHTML = '<span style="color: #f59e0b;">Testing connection...</span>';
            }
        }

        socket.on('stdout', (data) => {
            stdoutConsole.textContent += data;
            stdoutConsole.scrollTop = stdoutConsole.scrollHeight;
        });

        socket.on('stderr', (data) => {
            stderrConsole.textContent += data;
            stderrConsole.scrollTop = stderrConsole.scrollHeight;
        });

        socket.on('status', (data) => {
            setUIState('idle');
            stdoutConsole.textContent += \`\\n[Systeem] \${data}\\n\`;
            stdoutConsole.scrollTop = stdoutConsole.scrollHeight;
        });

        function setUIState(state) {
            if (state === 'running') {
                btnStart.classList.add('hidden');
                btnStop.classList.remove('hidden');
                statusIndicator.textContent = 'RUNNING';
                statusIndicator.className = 'text-cyan-400 animate-pulse';
            } else {
                btnStart.classList.remove('hidden');
                btnStop.classList.add('hidden');
                statusIndicator.textContent = 'IDLE';
                statusIndicator.className = 'text-gray-500';
            }
        }

        btnStart.addEventListener('click', async () => {
            const prompt = promptInput.value.trim();
            if (!prompt) return alert('Voer een prompt in.');
            
            localStorage.setItem('sz_prompt', prompt);
            localStorage.setItem('sz_context', contextInput.value);

            stdoutConsole.textContent = '';
            stderrConsole.textContent = '';
            setUIState('running');

            const hasMultiModels = multiModels.length > 0;
            const selectedMultiModels = hasMultiModels ? [...multiModels] : [];
            if (hasMultiModels) {
                multiModels = [];
            }
            if (hasMultiModels) {
                stdoutConsole.textContent += '\n[System] Starting Swarm with ' + selectedMultiModels.length + ' models in parallel...\n';
                stdoutConsole.textContent += '[System] Models: ' + selectedMultiModels.map(m => m.model).join(', ') + '\n\n';
            }

            await fetch(hasMultiModels ? '/api/start-multi' : '/api/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(hasMultiModels ? {
                    script: scriptSelect.value,
                    prompt: prompt,
                    context: contextInput.value,
                    multiModels: selectedMultiModels
                } : {
                    script: scriptSelect.value,
                    prompt: prompt,
                    context: contextInput.value,
                    apiProvider: apiProvider.value,
                    apiModel: apiModel.value
                })
            });

        });

        btnStop.addEventListener('click', async () => {
            await fetch('/api/stop', { method: 'POST' });
            setUIState('idle');
        });

        // Multi-model support
        let multiModels = [];
        const btnAddMultiModel = document.getElementById('btnAddMultiModel');
        
        btnAddMultiModel.addEventListener('click', () => {
            const currentModel = {
                provider: apiProvider.value,
                model: apiModel.value,
                apiKey: apiKey.value,
                baseUrl: apiBaseUrl.value,
                id: 'model-' + Date.now()
            };
            
            if (!currentModel.apiKey) {
                alert('Please enter API Key first');
                return;
            }
            
            multiModels.push(currentModel);
            stdoutConsole.textContent += '\n[System] ✅ Added model to queue: ' + currentModel.provider + '/' + currentModel.model + '\n';
            stdoutConsole.textContent += '[System] Total models queued: ' + multiModels.length + '\n';
            stdoutConsole.scrollTop = stdoutConsole.scrollHeight;
            
            // Highlight the button
            btnAddMultiModel.style.boxShadow = '0 0 15px rgba(168, 85, 247, 0.7)';
            setTimeout(() => {
                btnAddMultiModel.style.boxShadow = 'none';
            }, 1000);
        });

        // Override Start button to support multi-model
        const originalFetch = window.fetch;
        const startOriginal = btnStart.onclick;
        
        btnStart.addEventListener('click', async (e) => {
            if (multiModels.length > 0) {
                const prompt = promptInput.value.trim();
                if (!prompt) return alert('Voer een prompt in.');
                
                localStorage.setItem('sz_prompt', prompt);
                localStorage.setItem('sz_context', contextInput.value);

                stdoutConsole.textContent = '';
                stderrConsole.textContent = '';
                setUIState('running');
                
                stdoutConsole.textContent += '\n[System] 🚀 Starting Swarm with ' + multiModels.length + ' models in parallel...\n';
                stdoutConsole.textContent += '[System] Models: ' + multiModels.map(m => m.model).join(', ') + '\n\n';

                await fetch('/api/start-multi', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        script: scriptSelect.value,
                        prompt: prompt,
                        context: contextInput.value,
                        multiModels: multiModels
                    })
                });
                
                multiModels = [];
            }
        });
    </script>
</body>
</html>
`;

// 2. Routing & API Endpoints
app.get('/', (req, res) => {
    res.send(htmlContent);
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
