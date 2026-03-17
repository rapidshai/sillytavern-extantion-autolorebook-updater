/*
 * Smart RAG Lorebook - SillyTavern Extension
 * Version 1.0.4
 *
 * ============================================================
 * THIS EXTENSION WAS CREATED 100% WITH AI ASSISTANCE (CLAUDE OPUS).
 * No human-written code. Fully AI-generated.
 * ============================================================
 *
 * A non-destructive, two-step RAG system for Lorebook entries:
 * 1. Worker AI (or optionally the Main AI) compresses lorebook entries
 *    into structured Lite JSON format with deep-lore pointers.
 * 2. Main AI receives Lite context ALONGSIDE (never replacing) the
 *    original lorebook data, and can [FETCH: #pointer] for deep lore.
 *
 * Key principle: Original lorebook entries are NEVER modified or overwritten.
 * All Lite data is stored separately in the extension's own cache and
 * injected as an additional context layer.
 */

import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    getRequestHeaders,
} from '../../../../script.js';

import {
    extension_settings,
    getContext,
} from '../../../extensions.js';

// ============================================================================
// Constants
// ============================================================================

const EXTENSION_NAME = 'smart-rag-lorebook';

const DEFAULT_SETTINGS = {
    // Basic
    enabled: true,
    worker_endpoint: 'http://localhost:11434/v1/chat/completions',
    worker_model: 'llama3:8b',
    worker_api_key: '',
    auto_generate: true,
    inject_system_prompt: true,
    // Main AI Mode
    use_main_ai: false,
    // Advanced: Cache & Saving
    save_interval: 30,
    cache_ttl: 0,
    max_cache_entries: 500,
    // Advanced: Content Thresholds
    min_content_length: 500,
    max_lite_entries: 50,
    // Advanced: Worker AI Tuning
    worker_temperature: 0.2,
    worker_max_tokens: 1024,
    worker_timeout: 60,
    // Advanced: Injection
    injection_position: 0,
    injection_depth: 4,
    // Advanced: Deep Fetch
    max_fetch_depth: 3,
    show_fetch_toast: true,
    // Advanced: Debug
    debug_mode: false,
    // Internal
    lite_cache: {},
};

const WORKER_SYSTEM_PROMPT = `You are an expert data extractor for a roleplay engine. Your task is to analyze the provided lorebook entry and compress it into a highly efficient JSON format.

Rules:
1. Extract the absolute core details into short, comma-separated tags under quick_attributes.
2. For any deep, lengthy, or complex information (like history, detailed relationships, or complex rules), DO NOT include the full text. Instead, create a pointer in the deep_pointers array.
3. A pointer must have a pointer_tag starting with # (e.g., #Alice_History) and a very brief hint explaining what information is stored behind that tag.
4. Output ONLY valid JSON matching the exact schema provided. Do not add conversational text.

Schema:
{
  "entity_name": "Name of the character or concept",
  "entity_type": "Character | Location | Lore | Item",
  "core_identity": "One to two sentences summarizing the essence.",
  "quick_attributes": {
    "personality": ["trait1", "trait2", "trait3"],
    "appearance": ["feature1", "feature2"],
    "speech_style": ["style or limitation"]
  },
  "deep_pointers": [
    {
      "pointer_tag": "#Entity_Topic",
      "hint": "Brief hint about what info is stored here"
    }
  ]
}`;

const MAIN_AI_SYSTEM_INJECTION = `### DYNAMIC MEMORY SYSTEM ###
You have access to a dynamic external memory system to save context space.
Throughout the conversation, you may receive <Lite_Context> blocks containing brief summaries of characters, locations, or lore.
These are ADDITIONAL structured data — the original lorebook entries remain intact.
Inside these blocks, you will see "Available Deep Lore" with specific pointers starting with a hashtag (e.g., #Alice_History).

IMPORTANT: Read the <Lite_Context> JSON blocks for quick reference. They contain structured summaries you should use.

RULES FOR FETCHING MEMORY:
1. If the user asks a question or creates a scenario that requires deep knowledge you currently lack, DO NOT hallucinate or invent facts.
2. If a relevant pointer exists in the <Lite_Context>, you must request the full information by outputting the exact tag wrapped in a fetch command, like this:
    [FETCH: #Pointer_Name]
3. Stop generating your response immediately after outputting the [FETCH] command. The system will invisibly provide you with the deep lore and prompt you to continue seamlessly.`;

// ============================================================================
// State
// ============================================================================

let pendingDeepFetchContent = null;
let isRegenerating = false;
let currentFetchDepth = 0;
let activePointerMap = {};
let autoSaveTimerId = null;
let pendingSave = false;
let isProcessingEntries = false;

// ============================================================================
// Debug Logging
// ============================================================================

function debugLog(...args) {
    if (getSettings().debug_mode) {
        console.log('[SmartRAG]', ...args);
    }
}

// ============================================================================
// Progress Banner
// ============================================================================

const PROGRESS_BANNER_HTML = `
<div id="smart-rag-progress-banner">
    <div class="smart-rag-progress-header">
        <span class="smart-rag-progress-icon fa-solid fa-brain"></span>
        <span class="smart-rag-progress-title">Smart RAG Processing</span>
    </div>
    <div class="smart-rag-progress-text">Initializing...</div>
    <div class="smart-rag-progress-bar-container">
        <div class="smart-rag-progress-bar-fill" style="width: 0%"></div>
    </div>
    <div class="smart-rag-progress-counter">0 / 0</div>
</div>
`;

function initProgressBanner() {
    if ($('#smart-rag-progress-banner').length === 0) {
        $('body').append(PROGRESS_BANNER_HTML);
    }
}

function showProgressBanner(total) {
    initProgressBanner();
    const banner = $('#smart-rag-progress-banner');
    banner.find('.smart-rag-progress-text').text('Starting...');
    banner.find('.smart-rag-progress-bar-fill').css('width', '0%');
    banner.find('.smart-rag-progress-counter').text(`0 / ${total}`);
    banner.addClass('visible');
}

function updateProgressBanner(current, total, entryName) {
    const banner = $('#smart-rag-progress-banner');
    const pct = Math.round((current / total) * 100);
    banner.find('.smart-rag-progress-text').text(`Processing: ${entryName}`);
    banner.find('.smart-rag-progress-bar-fill').css('width', `${pct}%`);
    banner.find('.smart-rag-progress-counter').text(`${current} / ${total}`);
}

function hideProgressBanner() {
    const banner = $('#smart-rag-progress-banner');
    banner.removeClass('visible');
}

// ============================================================================
// Settings Management
// ============================================================================

function loadSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = {};
    }

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[EXTENSION_NAME][key] === undefined) {
            extension_settings[EXTENSION_NAME][key] = value;
        }
    }

    syncUIFromSettings();
}

function syncUIFromSettings() {
    const s = extension_settings[EXTENSION_NAME];

    // Basic
    $('#smart_rag_enabled').prop('checked', s.enabled);
    $('#smart_rag_worker_endpoint').val(s.worker_endpoint);
    $('#smart_rag_worker_model').val(s.worker_model);
    $('#smart_rag_worker_api_key').val(s.worker_api_key);
    $('#smart_rag_auto_generate').prop('checked', s.auto_generate);
    $('#smart_rag_inject_system_prompt').prop('checked', s.inject_system_prompt);

    // Main AI Mode
    $('#smart_rag_use_main_ai').prop('checked', s.use_main_ai);
    updateWorkerFieldsVisibility(s.use_main_ai);

    // Advanced: Cache & Saving
    $('#smart_rag_save_interval').val(s.save_interval);
    $('#smart_rag_cache_ttl').val(s.cache_ttl);
    $('#smart_rag_max_cache_entries').val(s.max_cache_entries);

    // Advanced: Content Thresholds
    $('#smart_rag_min_content_length').val(s.min_content_length);
    $('#smart_rag_max_lite_entries').val(s.max_lite_entries);

    // Advanced: Worker AI Tuning
    $('#smart_rag_worker_temperature').val(s.worker_temperature);
    $('#smart_rag_worker_temperature_value').text(s.worker_temperature);
    $('#smart_rag_worker_max_tokens').val(s.worker_max_tokens);
    $('#smart_rag_worker_timeout').val(s.worker_timeout);

    // Advanced: Injection
    $('#smart_rag_injection_position').val(s.injection_position);
    $('#smart_rag_injection_depth').val(s.injection_depth);
    updateDepthRowVisibility(s.injection_position);

    // Advanced: Deep Fetch
    $('#smart_rag_max_fetch_depth').val(s.max_fetch_depth);
    $('#smart_rag_show_fetch_toast').prop('checked', s.show_fetch_toast);

    // Advanced: Debug
    $('#smart_rag_debug_mode').prop('checked', s.debug_mode);
}

function saveSettings() {
    const s = extension_settings[EXTENSION_NAME];

    // Basic
    s.enabled = $('#smart_rag_enabled').is(':checked');
    s.worker_endpoint = $('#smart_rag_worker_endpoint').val().trim();
    s.worker_model = $('#smart_rag_worker_model').val().trim();
    s.worker_api_key = $('#smart_rag_worker_api_key').val().trim();
    s.auto_generate = $('#smart_rag_auto_generate').is(':checked');
    s.inject_system_prompt = $('#smart_rag_inject_system_prompt').is(':checked');

    // Main AI Mode
    s.use_main_ai = $('#smart_rag_use_main_ai').is(':checked');

    // Advanced: Cache & Saving
    s.save_interval = parseInt($('#smart_rag_save_interval').val()) || 30;
    s.cache_ttl = parseInt($('#smart_rag_cache_ttl').val()) || 0;
    s.max_cache_entries = parseInt($('#smart_rag_max_cache_entries').val()) || 500;

    // Advanced: Content Thresholds
    s.min_content_length = parseInt($('#smart_rag_min_content_length').val()) || 500;
    s.max_lite_entries = parseInt($('#smart_rag_max_lite_entries').val()) || 50;

    // Advanced: Worker AI Tuning
    s.worker_temperature = parseFloat($('#smart_rag_worker_temperature').val()) || 0.2;
    s.worker_max_tokens = parseInt($('#smart_rag_worker_max_tokens').val()) || 1024;
    s.worker_timeout = parseInt($('#smart_rag_worker_timeout').val()) || 60;

    // Advanced: Injection
    s.injection_position = parseInt($('#smart_rag_injection_position').val()) || 0;
    s.injection_depth = parseInt($('#smart_rag_injection_depth').val()) || 4;

    // Advanced: Deep Fetch
    s.max_fetch_depth = parseInt($('#smart_rag_max_fetch_depth').val()) || 3;
    s.show_fetch_toast = $('#smart_rag_show_fetch_toast').is(':checked');

    // Advanced: Debug
    s.debug_mode = $('#smart_rag_debug_mode').is(':checked');

    scheduleSave();
}

function getSettings() {
    return extension_settings[EXTENSION_NAME] || DEFAULT_SETTINGS;
}

// ============================================================================
// Auto-Save Timer
// ============================================================================

function scheduleSave() {
    const settings = getSettings();

    if (settings.save_interval <= 0) {
        saveSettingsDebounced();
        return;
    }

    pendingSave = true;

    if (!autoSaveTimerId) {
        autoSaveTimerId = setInterval(() => {
            if (pendingSave) {
                saveSettingsDebounced();
                pendingSave = false;
                debugLog('Auto-saved settings');
            }
        }, settings.save_interval * 1000);
    }
}

function stopAutoSave() {
    if (autoSaveTimerId) {
        clearInterval(autoSaveTimerId);
        autoSaveTimerId = null;
    }
    if (pendingSave) {
        saveSettingsDebounced();
        pendingSave = false;
    }
}

// ============================================================================
// Worker AI Communication
// ============================================================================

async function callWorkerAI(entryContent, entryName) {
    const settings = getSettings();

    const requestBody = {
        model: settings.worker_model,
        messages: [
            { role: 'system', content: WORKER_SYSTEM_PROMPT },
            {
                role: 'user',
                content: `Lorebook entry name: "${entryName}"\n\nFull content:\n${entryContent}`,
            },
        ],
        temperature: settings.worker_temperature,
        max_tokens: settings.worker_max_tokens,
    };

    const headers = { 'Content-Type': 'application/json' };
    if (settings.worker_api_key) {
        headers['Authorization'] = `Bearer ${settings.worker_api_key}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), settings.worker_timeout * 1000);

    try {
        const response = await fetch(settings.worker_endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.error(`[SmartRAG] Worker API error: ${response.status} ${response.statusText}`);
            return null;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;

        if (!content) {
            console.error('[SmartRAG] Worker returned empty content');
            return null;
        }

        return parseJsonResponse(content, entryName);
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            console.error(`[SmartRAG] Worker AI request timed out after ${settings.worker_timeout}s`);
        } else {
            console.error('[SmartRAG] Worker AI call failed:', err);
        }
        return null;
    }
}

// ============================================================================
// Main AI Communication (uses SillyTavern's active AI connection)
// ============================================================================

async function callMainAI(entryContent, entryName) {
    const context = getContext();

    if (typeof context.generateQuietPrompt !== 'function') {
        console.error('[SmartRAG] generateQuietPrompt is not available in this SillyTavern version.');
        toastr.error('Main AI processing requires SillyTavern 1.12+. Please use Worker AI mode instead.', 'Smart RAG');
        return null;
    }

    const prompt = [
        WORKER_SYSTEM_PROMPT,
        '',
        `Lorebook entry name: "${entryName}"`,
        '',
        'Full content:',
        entryContent,
        '',
        'Output ONLY the JSON, nothing else:',
    ].join('\n');

    try {
        debugLog('Calling Main AI for:', entryName);
        const response = await context.generateQuietPrompt(prompt);

        if (!response) {
            console.error('[SmartRAG] Main AI returned empty response');
            return null;
        }

        return parseJsonResponse(response, entryName);
    } catch (err) {
        console.error('[SmartRAG] Main AI call failed:', err);
        return null;
    }
}

// ============================================================================
// Shared JSON Parsing
// ============================================================================

function parseJsonResponse(content, entryName) {
    try {
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
        let jsonStr = jsonMatch[1].trim();

        // Try to find JSON object if the response has extra text
        const braceStart = jsonStr.indexOf('{');
        const braceEnd = jsonStr.lastIndexOf('}');
        if (braceStart !== -1 && braceEnd !== -1) {
            jsonStr = jsonStr.substring(braceStart, braceEnd + 1);
        }

        const parsed = JSON.parse(jsonStr);
        debugLog('Parsed result for', entryName, ':', parsed);
        return parsed;
    } catch (err) {
        console.error(`[SmartRAG] Failed to parse JSON for "${entryName}":`, err);
        return null;
    }
}

// ============================================================================
// Unified AI Call (routes to Worker or Main AI based on settings)
// ============================================================================

async function callAI(entryContent, entryName) {
    const settings = getSettings();

    if (settings.use_main_ai) {
        return callMainAI(entryContent, entryName);
    }

    return callWorkerAI(entryContent, entryName);
}

// ============================================================================
// Connection Test
// ============================================================================

async function testWorkerConnection() {
    const statusEl = $('#smart_rag_status');
    const settings = getSettings();
    const modeLabel = settings.use_main_ai ? 'Main AI' : 'Worker AI';

    statusEl.text(`Testing ${modeLabel} connection...`).attr('class', 'smart-rag-status info');

    try {
        const result = await callAI(
            'Alice is a powerful mage who lives in a dark tower. She has black hair and glowing eyes. She lost her family at age 10 when raiders destroyed her village.',
            'Test Entry',
        );

        if (result && result.entity_name) {
            statusEl.text(`${modeLabel} OK! Got: ${result.entity_name} (${result.entity_type})`).attr('class', 'smart-rag-status success');
        } else {
            statusEl.text(`${modeLabel} responded but format is unexpected.`).attr('class', 'smart-rag-status error');
        }
    } catch (err) {
        statusEl.text(`${modeLabel} failed: ${err.message}`).attr('class', 'smart-rag-status error');
    }
}

// ============================================================================
// Lite Cache Management
// ============================================================================

function getLiteCache() {
    const settings = getSettings();
    if (!settings.lite_cache) {
        settings.lite_cache = {};
    }
    return settings.lite_cache;
}

function hashContent(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return hash.toString(36);
}

/**
 * Evicts expired and over-limit cache entries.
 */
function evictCache() {
    const settings = getSettings();
    const cache = getLiteCache();
    const keys = Object.keys(cache);

    // Evict by TTL
    if (settings.cache_ttl > 0) {
        const now = Date.now();
        const ttlMs = settings.cache_ttl * 3600 * 1000;
        for (const key of keys) {
            const entry = cache[key];
            if (entry && entry._cached_at && (now - entry._cached_at) > ttlMs) {
                delete cache[key];
                debugLog('Evicted expired cache entry:', key);
            }
        }
    }

    // Evict by count (remove oldest first)
    const remaining = Object.keys(cache);
    if (remaining.length > settings.max_cache_entries) {
        const sorted = remaining.sort((a, b) => {
            const aTime = cache[a]?._cached_at || 0;
            const bTime = cache[b]?._cached_at || 0;
            return aTime - bTime;
        });
        const toRemove = sorted.slice(0, remaining.length - settings.max_cache_entries);
        for (const key of toRemove) {
            delete cache[key];
            debugLog('Evicted over-limit cache entry:', key);
        }
    }
}

async function getOrGenerateLite(uid, content, name, showToast = true) {
    const settings = getSettings();
    const cache = getLiteCache();
    const contentHash = hashContent(content);
    const cacheKey = `${uid}_${contentHash}`;

    if (cache[cacheKey]) {
        // Check TTL if set
        if (settings.cache_ttl > 0) {
            const ttlMs = settings.cache_ttl * 3600 * 1000;
            if (cache[cacheKey]._cached_at && (Date.now() - cache[cacheKey]._cached_at) > ttlMs) {
                delete cache[cacheKey];
                debugLog('Cache expired for:', name);
            } else {
                return cache[cacheKey];
            }
        } else {
            return cache[cacheKey];
        }
    }

    if (content.length < settings.min_content_length) {
        return null;
    }

    if (showToast) {
        toastr.info(`Generating Lite Context for: ${name}`, 'Smart RAG', { timeOut: 3000 });
    }

    const liteJson = await callAI(content, name);

    if (liteJson) {
        // Clear old hashes for this uid
        for (const key of Object.keys(cache)) {
            if (key.startsWith(`${uid}_`)) {
                delete cache[key];
            }
        }
        liteJson._cached_at = Date.now();
        cache[cacheKey] = liteJson;
        evictCache();
        scheduleSave();
    }

    return liteJson;
}

// ============================================================================
// Lite Context Formatting
// ============================================================================

function formatLiteContext(liteJson) {
    const attrs = liteJson.quick_attributes || {};
    const lines = [];

    lines.push(`<Lite_Context: ${liteJson.entity_name}>`);
    lines.push(`Type: ${liteJson.entity_type}`);
    lines.push(`Core: ${liteJson.core_identity}`);

    const attrParts = [];
    if (attrs.personality?.length) attrParts.push(`[Personality: ${attrs.personality.join(', ')}]`);
    if (attrs.appearance?.length) attrParts.push(`[Appearance: ${attrs.appearance.join(', ')}]`);
    if (attrs.speech_style?.length) attrParts.push(`[Speech: ${attrs.speech_style.join(', ')}]`);

    for (const [key, val] of Object.entries(attrs)) {
        if (!['personality', 'appearance', 'speech_style'].includes(key) && Array.isArray(val)) {
            attrParts.push(`[${key}: ${val.join(', ')}]`);
        }
    }

    if (attrParts.length) {
        lines.push(`Attributes: ${attrParts.join(' ')}`);
    }

    const pointers = liteJson.deep_pointers || [];
    if (pointers.length) {
        lines.push('Available Deep Lore (Request using tag if needed):');
        for (const p of pointers) {
            lines.push(`  - ${p.pointer_tag}: ${p.hint}`);
        }
    }

    lines.push(`</Lite_Context>`);
    return lines.join('\n');
}

// ============================================================================
// World Info / Lorebook Access (READ-ONLY — never modifies entries)
// ============================================================================

function getWorldInfoEntries() {
    const context = getContext();
    const entries = [];

    if (context.worldInfo) {
        for (const [uid, entry] of Object.entries(context.worldInfo)) {
            if (entry && entry.content && !entry.disable) {
                entries.push({
                    uid,
                    name: entry.comment || entry.key?.[0] || `Entry_${uid}`,
                    content: entry.content,
                    keys: entry.key || [],
                    originalEntry: entry,
                });
            }
        }
    }

    return entries;
}

function resolvePointer(pointerTag) {
    const pointerInfo = activePointerMap[pointerTag];
    if (!pointerInfo) {
        console.warn(`[SmartRAG] Unknown pointer: ${pointerTag}`);
        return null;
    }

    const entries = getWorldInfoEntries();
    const entry = entries.find(e => e.uid === pointerInfo.entryUid);
    if (!entry) {
        console.warn(`[SmartRAG] Entry not found for pointer: ${pointerTag}`);
        return null;
    }

    return entry.content;
}

// ============================================================================
// Context Injection (non-destructive — adds alongside, never replaces)
// ============================================================================

async function onGenerationStarted(eventData) {
    const settings = getSettings();
    if (!settings.enabled) return;

    activePointerMap = {};

    const entries = getWorldInfoEntries();
    const liteBlocks = [];
    let count = 0;

    // Find entries that need processing (uncached)
    const uncachedEntries = [];
    for (const entry of entries) {
        if (count >= settings.max_lite_entries) break;
        const cache = getLiteCache();
        const contentHash = hashContent(entry.content);
        const cacheKey = `${entry.uid}_${contentHash}`;
        if (!cache[cacheKey] && entry.content.length >= settings.min_content_length) {
            uncachedEntries.push(entry);
        }
        count++;
    }

    // Show progress banner if there are entries to process
    const totalToProcess = uncachedEntries.length;
    if (totalToProcess > 0) {
        showProgressBanner(totalToProcess);
        isProcessingEntries = true;
    }

    count = 0;
    let processedCount = 0;

    for (const entry of entries) {
        if (count >= settings.max_lite_entries) break;

        // Update progress if this entry needs processing
        if (uncachedEntries.includes(entry)) {
            processedCount++;
            updateProgressBanner(processedCount, totalToProcess, entry.name);
        }

        const liteJson = await getOrGenerateLite(entry.uid, entry.content, entry.name, false);

        if (liteJson) {
            if (liteJson.deep_pointers) {
                for (const pointer of liteJson.deep_pointers) {
                    activePointerMap[pointer.pointer_tag] = {
                        entryUid: entry.uid,
                        sectionHint: pointer.hint,
                    };
                }
            }
            liteBlocks.push(formatLiteContext(liteJson));
            count++;
        }
    }

    // Hide progress banner
    if (totalToProcess > 0) {
        hideProgressBanner();
        isProcessingEntries = false;
    }

    if (liteBlocks.length > 0) {
        const liteContent = '<Available_Knowledge>\n' + liteBlocks.join('\n\n') + '\n</Available_Knowledge>';
        const context = getContext();
        if (typeof context.setExtensionPrompt === 'function') {
            context.setExtensionPrompt(
                EXTENSION_NAME + '_lite',
                liteContent,
                settings.injection_position,
                settings.injection_depth,
            );
        }
        debugLog(`Injected ${liteBlocks.length} Lite contexts at position ${settings.injection_position}`);
    }

    if (settings.inject_system_prompt) {
        const context = getContext();
        if (typeof context.setExtensionPrompt === 'function') {
            context.setExtensionPrompt(
                EXTENSION_NAME + '_system',
                MAIN_AI_SYSTEM_INJECTION,
                1, // BEFORE_PROMPT
                0,
            );
        }
    }

    if (pendingDeepFetchContent) {
        const context = getContext();
        if (typeof context.setExtensionPrompt === 'function') {
            context.setExtensionPrompt(
                EXTENSION_NAME + '_deep',
                `<Deep_Lore_Response>\n${pendingDeepFetchContent}\n</Deep_Lore_Response>\nNow continue your response seamlessly using the deep lore above. Do not mention the fetch system.`,
                settings.injection_position,
                settings.injection_depth,
            );
        }
        pendingDeepFetchContent = null;
        isRegenerating = false;
    }
}

// ============================================================================
// FETCH Interception
// ============================================================================

async function onMessageReceived(messageIndex) {
    const settings = getSettings();
    if (!settings.enabled || isRegenerating) return;

    const context = getContext();
    const chat = context.chat;

    if (!chat || messageIndex < 0 || messageIndex >= chat.length) return;

    const message = chat[messageIndex];
    if (!message || message.is_user) return;

    const text = message.mes || '';

    const fetchMatch = text.match(/\[FETCH:\s*(#[\w_]+)\s*\]/);
    if (!fetchMatch) {
        currentFetchDepth = 0;
        return;
    }

    // Loop protection
    currentFetchDepth++;
    if (currentFetchDepth > settings.max_fetch_depth) {
        console.warn(`[SmartRAG] Max fetch depth (${settings.max_fetch_depth}) reached, stopping.`);
        toastr.warning(`Max FETCH depth reached (${settings.max_fetch_depth}). Stopping to prevent loops.`, 'Smart RAG');
        currentFetchDepth = 0;
        return;
    }

    const pointerTag = fetchMatch[1];
    debugLog(`Detected FETCH request for: ${pointerTag} (depth ${currentFetchDepth})`);

    const deepContent = resolvePointer(pointerTag);
    if (!deepContent) {
        console.warn(`[SmartRAG] Could not resolve pointer: ${pointerTag}`);
        toastr.warning(`Could not resolve pointer: ${pointerTag}`, 'Smart RAG');
        currentFetchDepth = 0;
        return;
    }

    pendingDeepFetchContent = `[Deep Lore for ${pointerTag}]\n${deepContent}`;
    isRegenerating = true;

    if (settings.show_fetch_toast) {
        toastr.info(`Fetching deep lore: ${pointerTag}`, 'Smart RAG', { timeOut: 2000 });
    }

    if (typeof context.deleteMessageByIndex === 'function') {
        await context.deleteMessageByIndex(messageIndex);
    } else {
        chat.splice(messageIndex, 1);
        $(`.mes[mesid="${messageIndex}"]`).remove();
    }

    if (typeof context.generate === 'function') {
        await context.generate('normal');
    } else {
        $('#option_regenerate').trigger('click');
    }
}

// ============================================================================
// Bulk Operations
// ============================================================================

async function generateAllLiteEntries() {
    const settings = getSettings();

    if (!settings.use_main_ai && (!settings.worker_endpoint || !settings.worker_model)) {
        toastr.error('Please configure Worker AI endpoint and model first, or enable Main AI mode.', 'Smart RAG');
        return;
    }

    const entries = getWorldInfoEntries();
    const statusEl = $('#smart_rag_status');

    if (entries.length === 0) {
        statusEl.text('No active lorebook entries found.').attr('class', 'smart-rag-status info');
        return;
    }

    // Filter entries that need processing
    const entriesToProcess = entries.filter(e => {
        if (e.content.length < settings.min_content_length) return false;
        const cache = getLiteCache();
        const contentHash = hashContent(e.content);
        const cacheKey = `${e.uid}_${contentHash}`;
        return !cache[cacheKey];
    });

    const totalNeedProcessing = entriesToProcess.length;
    const totalSkippedShort = entries.filter(e => e.content.length < settings.min_content_length).length;
    const alreadyCached = entries.length - totalNeedProcessing - totalSkippedShort;

    if (totalNeedProcessing === 0) {
        statusEl.text(`All entries already cached (${alreadyCached} cached, ${totalSkippedShort} too short).`).attr('class', 'smart-rag-status success');
        return;
    }

    showProgressBanner(totalNeedProcessing);
    isProcessingEntries = true;

    let generated = 0;
    let failed = 0;

    for (let i = 0; i < entriesToProcess.length; i++) {
        const entry = entriesToProcess[i];
        updateProgressBanner(i + 1, totalNeedProcessing, entry.name);
        statusEl.text(`Processing ${i + 1}/${totalNeedProcessing}: ${entry.name}...`).attr('class', 'smart-rag-status info');

        const result = await getOrGenerateLite(entry.uid, entry.content, entry.name, false);
        if (result) {
            generated++;
        } else {
            failed++;
        }
    }

    hideProgressBanner();
    isProcessingEntries = false;

    const summary = `Done! Generated: ${generated}, Failed: ${failed}, Already cached: ${alreadyCached}, Too short: ${totalSkippedShort}`;
    statusEl.text(summary).attr('class', 'smart-rag-status success');
    toastr.success(`Generated ${generated} Lite entries`, 'Smart RAG');
}

function clearLiteCache() {
    const settings = getSettings();
    settings.lite_cache = {};
    saveSettingsDebounced();
    activePointerMap = {};
    toastr.info('Lite cache cleared.', 'Smart RAG');
    $('#smart_rag_status').text('Cache cleared.').attr('class', 'smart-rag-status info');
}

// ============================================================================
// Cache Import / Export
// ============================================================================

function exportCache() {
    const cache = getLiteCache();
    const count = Object.keys(cache).length;

    if (count === 0) {
        toastr.info('Cache is empty, nothing to export.', 'Smart RAG');
        return;
    }

    const blob = new Blob([JSON.stringify(cache, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smart-rag-cache-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);

    toastr.success(`Exported ${count} cache entries.`, 'Smart RAG');
}

function importCache() {
    $('#smart_rag_import_file').trigger('click');
}

function handleImportFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const imported = JSON.parse(e.target.result);
            if (typeof imported !== 'object' || Array.isArray(imported)) {
                throw new Error('Invalid format');
            }

            const cache = getLiteCache();
            let count = 0;

            for (const [key, value] of Object.entries(imported)) {
                if (value && typeof value === 'object' && value.entity_name) {
                    cache[key] = value;
                    count++;
                }
            }

            evictCache();
            saveSettingsDebounced();
            toastr.success(`Imported ${count} cache entries.`, 'Smart RAG');
            $('#smart_rag_status').text(`Imported ${count} entries.`).attr('class', 'smart-rag-status success');
        } catch (err) {
            toastr.error(`Import failed: ${err.message}`, 'Smart RAG');
        }
    };
    reader.readAsText(file);

    // Reset so same file can be re-imported
    event.target.value = '';
}

// ============================================================================
// Chat Change Handler
// ============================================================================

async function onChatChanged() {
    const settings = getSettings();
    if (!settings.enabled || !settings.auto_generate) return;

    await new Promise(r => setTimeout(r, 1000));

    const entries = getWorldInfoEntries();
    let needsGeneration = false;

    for (const entry of entries) {
        if (entry.content.length >= settings.min_content_length) {
            const cache = getLiteCache();
            const contentHash = hashContent(entry.content);
            const cacheKey = `${entry.uid}_${contentHash}`;
            if (!cache[cacheKey]) {
                needsGeneration = true;
                break;
            }
        }
    }

    if (needsGeneration) {
        debugLog('Auto-generating Lite entries for new chat...');
        await generateAllLiteEntries();
    }
}

// ============================================================================
// UI Helpers
// ============================================================================

function updateDepthRowVisibility(positionValue) {
    const depthRow = $('#smart_rag_depth_row');
    if (parseInt(positionValue) === 4) {
        depthRow.removeClass('hidden');
    } else {
        depthRow.addClass('hidden');
    }
}

function updateWorkerFieldsVisibility(useMainAI) {
    const workerFields = $('#smart_rag_worker_fields');
    if (useMainAI) {
        workerFields.addClass('hidden');
    } else {
        workerFields.removeClass('hidden');
    }
}

function toggleAdvancedSettings() {
    const toggle = $('#smart_rag_advanced_toggle');
    const content = $('#smart_rag_advanced_content');
    toggle.toggleClass('open');
    content.toggleClass('open');
}

// ============================================================================
// Settings Panel HTML (inline - no external file dependency)
// ============================================================================

const SETTINGS_HTML = `
<div id="smart-rag-lorebook-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Smart RAG Lorebook</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

            <!-- ========== BASIC SETTINGS ========== -->

            <div class="smart-rag-setting-row">
                <label class="checkbox_label" for="smart_rag_enabled">
                    <input type="checkbox" id="smart_rag_enabled" />
                    <span>Enable Smart RAG</span>
                </label>
            </div>

            <hr />

            <!-- ========== MAIN AI MODE ========== -->

            <div class="smart-rag-setting-row smart-rag-main-ai-section">
                <label class="checkbox_label" for="smart_rag_use_main_ai">
                    <input type="checkbox" id="smart_rag_use_main_ai" />
                    <span>Use Main AI for processing</span>
                </label>
                <small class="smart-rag-hint">
                    When enabled, lorebook entries are processed using your main SillyTavern AI connection
                    instead of a separate Worker AI. This is slower but requires no additional setup.
                    A progress indicator will appear at the top of the screen during processing.
                </small>
            </div>

            <hr />

            <!-- ========== WORKER AI CONNECTION (hidden when Main AI is on) ========== -->

            <div id="smart_rag_worker_fields">
                <h4>Worker AI Connection</h4>

                <div class="smart-rag-setting-row">
                    <label for="smart_rag_worker_endpoint">API Endpoint</label>
                    <input type="text" id="smart_rag_worker_endpoint" class="text_pole" placeholder="http://localhost:11434/v1/chat/completions" />
                    <small class="smart-rag-hint">OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter, etc.)</small>
                </div>

                <div class="smart-rag-setting-row">
                    <label for="smart_rag_worker_model">Model Name</label>
                    <input type="text" id="smart_rag_worker_model" class="text_pole" placeholder="llama3:8b" />
                </div>

                <div class="smart-rag-setting-row">
                    <label for="smart_rag_worker_api_key">API Key (optional)</label>
                    <input type="password" id="smart_rag_worker_api_key" class="text_pole" placeholder="Leave empty for local models" />
                </div>

                <hr />
            </div>

            <h4>Basic Behavior</h4>

            <div class="smart-rag-setting-row">
                <label class="checkbox_label" for="smart_rag_auto_generate">
                    <input type="checkbox" id="smart_rag_auto_generate" />
                    <span>Auto-generate Lite versions on chat start</span>
                </label>
                <small class="smart-rag-hint">Automatically compress long lorebook entries when opening a chat</small>
            </div>

            <div class="smart-rag-setting-row">
                <label class="checkbox_label" for="smart_rag_inject_system_prompt">
                    <input type="checkbox" id="smart_rag_inject_system_prompt" />
                    <span>Inject FETCH instructions into system prompt</span>
                </label>
                <small class="smart-rag-hint">Teaches the Main AI how to request deep lore via [FETCH: #tag]</small>
            </div>

            <hr />

            <!-- ========== ACTIONS ========== -->

            <h4>Actions</h4>
            <div class="smart-rag-button-row">
                <input type="button" id="smart_rag_generate_all" class="menu_button" value="Generate All Lite" />
                <input type="button" id="smart_rag_clear_cache" class="menu_button" value="Clear Cache" />
                <input type="button" id="smart_rag_test_worker" class="menu_button" value="Test Connection" />
            </div>

            <div id="smart_rag_status" class="smart-rag-status"></div>

            <hr />

            <!-- ========== ADVANCED SETTINGS (Spoiler) ========== -->

            <div class="smart-rag-advanced-toggle" id="smart_rag_advanced_toggle">
                <span class="fa-solid fa-gear"></span>
                <span>Advanced Settings</span>
                <span class="fa-solid fa-chevron-down smart-rag-advanced-arrow"></span>
            </div>

            <div class="smart-rag-advanced-content" id="smart_rag_advanced_content">

                <!-- Cache & Save -->
                <h4>Cache & Saving</h4>

                <div class="smart-rag-setting-row">
                    <label for="smart_rag_save_interval">Auto-save interval (seconds)</label>
                    <input type="number" id="smart_rag_save_interval" class="text_pole" min="5" max="600" step="5" />
                    <small class="smart-rag-hint">How often to persist the Lite cache to settings (0 = save immediately)</small>
                </div>

                <div class="smart-rag-setting-row">
                    <label for="smart_rag_cache_ttl">Cache TTL (hours)</label>
                    <input type="number" id="smart_rag_cache_ttl" class="text_pole" min="0" max="8760" step="1" />
                    <small class="smart-rag-hint">Cached Lite entries older than this will be regenerated (0 = never expire)</small>
                </div>

                <div class="smart-rag-setting-row">
                    <label for="smart_rag_max_cache_entries">Max cached entries</label>
                    <input type="number" id="smart_rag_max_cache_entries" class="text_pole" min="10" max="10000" step="10" />
                    <small class="smart-rag-hint">Oldest entries are evicted when limit is reached</small>
                </div>

                <hr />

                <!-- Content Thresholds -->
                <h4>Content Thresholds</h4>

                <div class="smart-rag-setting-row">
                    <label for="smart_rag_min_content_length">Min content length to summarize (chars)</label>
                    <input type="number" id="smart_rag_min_content_length" class="text_pole" min="100" max="50000" step="100" />
                    <small class="smart-rag-hint">Entries shorter than this will be injected as-is without compression</small>
                </div>

                <div class="smart-rag-setting-row">
                    <label for="smart_rag_max_lite_entries">Max Lite entries per generation</label>
                    <input type="number" id="smart_rag_max_lite_entries" class="text_pole" min="1" max="200" step="1" />
                    <small class="smart-rag-hint">Limit how many Lite contexts are injected into each prompt</small>
                </div>

                <hr />

                <!-- Worker AI Tuning -->
                <h4>Worker AI Tuning</h4>

                <div class="smart-rag-setting-row">
                    <label for="smart_rag_worker_temperature">Temperature</label>
                    <div class="smart-rag-range-row">
                        <input type="range" id="smart_rag_worker_temperature" min="0" max="1" step="0.05" />
                        <span id="smart_rag_worker_temperature_value" class="smart-rag-range-value">0.2</span>
                    </div>
                    <small class="smart-rag-hint">Lower = more consistent summaries, higher = more creative</small>
                </div>

                <div class="smart-rag-setting-row">
                    <label for="smart_rag_worker_max_tokens">Max response tokens</label>
                    <input type="number" id="smart_rag_worker_max_tokens" class="text_pole" min="128" max="4096" step="64" />
                    <small class="smart-rag-hint">Maximum tokens for the Worker AI Lite JSON response</small>
                </div>

                <div class="smart-rag-setting-row">
                    <label for="smart_rag_worker_timeout">Request timeout (seconds)</label>
                    <input type="number" id="smart_rag_worker_timeout" class="text_pole" min="5" max="300" step="5" />
                    <small class="smart-rag-hint">Abort Worker AI request after this many seconds</small>
                </div>

                <hr />

                <!-- Injection Settings -->
                <h4>Injection Settings</h4>

                <div class="smart-rag-setting-row">
                    <label for="smart_rag_injection_position">Injection position</label>
                    <select id="smart_rag_injection_position" class="text_pole">
                        <option value="0">After character definition (IN_PROMPT)</option>
                        <option value="1">Before system prompt (BEFORE_PROMPT)</option>
                        <option value="2">After system prompt (AFTER_PROMPT)</option>
                        <option value="4">At depth in chat (AT_DEPTH)</option>
                    </select>
                    <small class="smart-rag-hint">Where to place the Lite context in the prompt</small>
                </div>

                <div class="smart-rag-setting-row smart-rag-depth-row" id="smart_rag_depth_row">
                    <label for="smart_rag_injection_depth">Injection depth</label>
                    <input type="number" id="smart_rag_injection_depth" class="text_pole" min="0" max="100" step="1" />
                    <small class="smart-rag-hint">Number of messages from the end (only for AT_DEPTH)</small>
                </div>

                <hr />

                <!-- Deep Fetch Settings -->
                <h4>Deep Fetch</h4>

                <div class="smart-rag-setting-row">
                    <label for="smart_rag_max_fetch_depth">Max FETCH depth per message</label>
                    <input type="number" id="smart_rag_max_fetch_depth" class="text_pole" min="1" max="10" step="1" />
                    <small class="smart-rag-hint">Max consecutive FETCH cycles before forcing a response (prevents loops)</small>
                </div>

                <div class="smart-rag-setting-row">
                    <label class="checkbox_label" for="smart_rag_show_fetch_toast">
                        <input type="checkbox" id="smart_rag_show_fetch_toast" />
                        <span>Show notification on FETCH</span>
                    </label>
                    <small class="smart-rag-hint">Display a toast when the AI triggers a deep lore fetch</small>
                </div>

                <hr />

                <!-- Debug -->
                <h4>Debug</h4>

                <div class="smart-rag-setting-row">
                    <label class="checkbox_label" for="smart_rag_debug_mode">
                        <input type="checkbox" id="smart_rag_debug_mode" />
                        <span>Debug mode</span>
                    </label>
                    <small class="smart-rag-hint">Log detailed info to browser console (F12)</small>
                </div>

                <div class="smart-rag-button-row">
                    <input type="button" id="smart_rag_export_cache" class="menu_button" value="Export Cache (JSON)" />
                    <input type="button" id="smart_rag_import_cache" class="menu_button" value="Import Cache" />
                </div>
                <input type="file" id="smart_rag_import_file" accept=".json" style="display:none" />
            </div>

        </div>
    </div>
</div>
`;

// ============================================================================
// Initialization
// ============================================================================

jQuery(async () => {
    $('#extensions_settings2').append(SETTINGS_HTML);

    loadSettings();

    // === Basic settings bindings ===
    $('#smart_rag_enabled').on('change', saveSettings);
    $('#smart_rag_worker_endpoint').on('input', saveSettings);
    $('#smart_rag_worker_model').on('input', saveSettings);
    $('#smart_rag_worker_api_key').on('input', saveSettings);
    $('#smart_rag_auto_generate').on('change', saveSettings);
    $('#smart_rag_inject_system_prompt').on('change', saveSettings);

    // === Main AI mode binding ===
    $('#smart_rag_use_main_ai').on('change', function () {
        updateWorkerFieldsVisibility($(this).is(':checked'));
        saveSettings();
    });

    // === Advanced settings bindings ===
    $('#smart_rag_save_interval').on('input', () => {
        stopAutoSave();
        saveSettings();
    });
    $('#smart_rag_cache_ttl').on('input', saveSettings);
    $('#smart_rag_max_cache_entries').on('input', saveSettings);
    $('#smart_rag_min_content_length').on('input', saveSettings);
    $('#smart_rag_max_lite_entries').on('input', saveSettings);
    $('#smart_rag_worker_temperature').on('input', function () {
        $('#smart_rag_worker_temperature_value').text($(this).val());
        saveSettings();
    });
    $('#smart_rag_worker_max_tokens').on('input', saveSettings);
    $('#smart_rag_worker_timeout').on('input', saveSettings);
    $('#smart_rag_injection_position').on('change', function () {
        updateDepthRowVisibility($(this).val());
        saveSettings();
    });
    $('#smart_rag_injection_depth').on('input', saveSettings);
    $('#smart_rag_max_fetch_depth').on('input', saveSettings);
    $('#smart_rag_show_fetch_toast').on('change', saveSettings);
    $('#smart_rag_debug_mode').on('change', saveSettings);

    // === Button handlers ===
    $('#smart_rag_generate_all').on('click', generateAllLiteEntries);
    $('#smart_rag_clear_cache').on('click', clearLiteCache);
    $('#smart_rag_test_worker').on('click', testWorkerConnection);
    $('#smart_rag_export_cache').on('click', exportCache);
    $('#smart_rag_import_cache').on('click', importCache);
    $('#smart_rag_import_file').on('change', handleImportFile);

    // === Advanced spoiler toggle ===
    $('#smart_rag_advanced_toggle').on('click', toggleAdvancedSettings);

    // === Depth row visibility on load ===
    updateDepthRowVisibility(getSettings().injection_position);

    // === Event hooks ===
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    console.log('[SmartRAG] Smart RAG Lorebook extension v1.0.4 loaded.');
});
